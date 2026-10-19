import { newElement, newTextElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { assertVaultDeploymentReady } from "../capabilities";
import { VaultError } from "../errors";
import { decryptVaultFile, encryptVaultFile } from "../fileAssets";
import { VaultLocalStore } from "../local-store";
import { createVaultOwnerService } from "../owner";

import {
  FakeAssetServer,
  TEST_FILE_ID,
  imageElement,
  imageFile,
} from "./assetTestUtils";

import { getVaultV2LinkData } from "./link";
import { VAULT_V2_LOCAL_DB_VERSION, VaultV2LocalStore } from "./localStore";
import { VaultSceneMaterializer } from "./materialize";
import {
  cancelVaultV2Migration,
  migrateVaultToV2,
  readVaultV2Migration,
} from "./migration";
import { MockVaultRoom } from "./mockRoom";
import {
  VaultV2Reassembler,
  createVaultV2Keys,
  fromB64,
  openVaultV2,
} from "./protocol";
import { VaultSceneDoc } from "./sceneDoc";
import { buildBasicScene, byId, withId } from "./testUtils";

import type { VaultV2Creator } from "./creation";
import type {
  VaultV2MigrationJournal,
  VaultV2MigrationJournalRecord,
} from "./localStore";
import type {
  VaultV2MigrationDependencies,
  VaultV2MigrationResult,
  VaultV2MigrationSource,
} from "./migration";

const SOURCE_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SOURCE_KEY = `${"D".repeat(42)}A`;
const ROOM_ID = "room_1234567890abcdef";

const deployment = () =>
  assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1, 2],
      roomProtocolVersions: [1, 2],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );

type VaultState = "creating" | "active" | "failed" | "revoked" | "deleted";

/** the server side the migration talks to: vault rows + snapshot RPC */
class FakeBackend {
  readonly vaults = new Map<string, VaultState>();
  readonly rooms = new Map<string, MockVaultRoom>();
  readonly calls: string[] = [];
  /** when set, activate never settles (a tab killed mid-create) */
  hangActivate = false;

  readonly createV2: VaultV2Creator = async (input) => {
    this.calls.push(`create:${input.vaultId}`);
    if (this.vaults.has(input.vaultId)) {
      throw new VaultError("VAULT_ALREADY_EXISTS", "exists");
    }
    this.vaults.set(input.vaultId, "creating");
    return {
      vaultId: input.vaultId,
      invitationId: "223e4567-e89b-42d3-a456-426614174000",
    };
  };

  private transition(
    vaultId: string,
    from: readonly VaultState[],
    to: VaultState,
  ) {
    const state = this.vaults.get(vaultId);
    if (!state || !from.includes(state)) {
      throw new VaultError("VAULT_NOT_FOUND", "not found");
    }
    this.vaults.set(vaultId, to);
  }

  readonly owner = createVaultOwnerService(deployment(), {
    create: async () => {
      throw new Error("v1 create is never used");
    },
    activate: async (input) => {
      this.calls.push(`activate:${input.vaultId}`);
      if (this.hangActivate) {
        return new Promise(() => {});
      }
      this.transition(input.vaultId, ["creating"], "active");
      return {
        vaultId: input.vaultId,
        state: "active",
        activeRoomId: input.activeRoomId,
      };
    },
    failCreation: async (vaultId) => {
      this.calls.push(`fail:${vaultId}`);
      this.transition(vaultId, ["creating"], "failed");
    },
    createInvitation: async () => {
      throw new Error("unused");
    },
    revokeInvitation: async () => {
      throw new Error("unused");
    },
    revokeVault: async (vaultId) => {
      this.calls.push(`revoke:${vaultId}`);
      this.transition(vaultId, ["active", "revoked"], "revoked");
      return { vaultId, reason: "vault-revoked" };
    },
    softDeleteVault: async (vaultId) => {
      this.calls.push(`delete:${vaultId}`);
      this.transition(vaultId, ["revoked", "failed", "deleted"], "deleted");
      return { vaultId, reason: "vault-deleted", deleteAfter: 0 };
    },
  });

  readonly provision = {
    provision: async () => ({
      kind: "vault-room" as const,
      activeRoomId: ROOM_ID,
    }),
  };

  room(vaultId: string) {
    let room = this.rooms.get(vaultId);
    if (!room) {
      room = new MockVaultRoom();
      this.rooms.set(vaultId, room);
    }
    return room;
  }

  count(prefix: string) {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

const memoryJournal = () => {
  const records = new Map<string, VaultV2MigrationJournalRecord>();
  const journal: VaultV2MigrationJournal = {
    get: async (id) => records.get(id.toLowerCase()) ?? null,
    put: async (record) => {
      records.set(record.sourceVaultId, record);
    },
    delete: async (id) => {
      records.delete(id.toLowerCase());
    },
  };
  return { journal, records };
};

/** a v1 scene: basic scene + a deleted element + a blank text */
const sourceScene = () => {
  const deleted = withId(
    {
      ...newElement({ type: "diamond", x: 0, y: 500, width: 50, height: 50 }),
      isDeleted: true,
    },
    "gone-1",
    "a5",
  );
  const blank = withId(
    newTextElement({ x: 0, y: 900, text: "   ", fontSize: 20, fontFamily: 1 }),
    "blank-1",
    "a6",
  );
  return {
    elements: [...buildBasicScene(), deleted, blank] as ExcalidrawElement[],
    appState: { viewBackgroundColor: "#fafafa", gridModeEnabled: true },
  };
};

const makeSource = (
  overrides: Partial<VaultV2MigrationSource> = {},
): VaultV2MigrationSource & { reads: number } => {
  const scene = sourceScene();
  const source = {
    vaultId: SOURCE_ID,
    rootKey: SOURCE_KEY,
    role: "editor" as const,
    reads: 0,
    readScene: () => {
      source.reads += 1;
      return scene;
    },
    ...overrides,
  };
  return source;
};

const setup = (overrides: Partial<VaultV2MigrationDependencies> = {}) => {
  const backend = new FakeBackend();
  const { journal, records } = memoryJournal();
  const deps: VaultV2MigrationDependencies = {
    journal,
    createV2: backend.createV2,
    owner: backend.owner,
    rooms: backend.provision,
    createSnapshotStore: ({ vaultId }) =>
      backend.room(vaultId).snapshotStore("editor"),
    baseUrl: "https://calileon.com/",
    lock: (_name, body) => body(),
    ...overrides,
  };
  return { backend, journal, records, deps };
};

/** opens the new Vault's committed snapshot with the keys from its link */
const readMigrated = async (
  backend: FakeBackend,
  result: VaultV2MigrationResult,
) => {
  const link = getVaultV2LinkData(result.editorLink)!;
  const keys = createVaultV2Keys(link.rootKey, link.vaultId);
  const stored = backend.room(link.vaultId).snapshot!;
  const reassembler = new VaultV2Reassembler(Number.MAX_SAFE_INTEGER);
  const scene = new VaultSceneDoc({ actorId: "reader" });
  for (const raw of stored.envelopes) {
    const { envelope, plaintext } = await openVaultV2(keys, raw);
    expect(envelope).toMatchObject({
      vaultId: link.vaultId,
      roomId: ROOM_ID,
      generation: 1,
    });
    const inner = reassembler.accept(envelope, plaintext);
    if (inner?.kind === "sync.snapshot") {
      scene.applyRemoteUpdate(fromB64(inner.state));
    }
  }
  return { scene, stored, link };
};

const crashAt = (stage: string) => async (current: string) => {
  if (current === stage) {
    throw new Error(`crash after ${stage}`);
  }
};

describe("migrateVaultToV2 (W4)", () => {
  it("imports the visible v1 scene into a new v2 Vault at generation 1", async () => {
    const { backend, records, deps } = setup();
    const source = makeSource();
    const before = JSON.stringify(source.readScene());

    const result = await migrateVaultToV2(source, deps);

    expect(result.sourceVaultId).toBe(SOURCE_ID);
    expect(result.vaultId).not.toBe(SOURCE_ID);
    expect(result.migratedElements).toBe(5);
    expect(result.resumed).toBe(false);
    expect(backend.vaults.get(result.vaultId)).toBe("active");

    const { scene, stored, link } = await readMigrated(backend, result);
    expect(stored.generation).toBe(1);
    expect(link.rootKey).not.toBe(SOURCE_KEY);
    expect(scene.meta.get("createdBy")).toBe("migration");
    expect(scene.meta.get("sourceVaultId")).toBe(SOURCE_ID);

    const elements = new VaultSceneMaterializer(scene)
      .materialize()
      .elements.filter((element) => !element.isDeleted);
    expect(elements.map((element) => element.id).sort()).toEqual(
      ["arrow-1", "box-1", "box-2", "label-1", "note-1"].sort(),
    );
    expect((byId(elements, "label-1") as any).originalText).toBe("hello world");
    // v1 delete history stays in v1
    expect(scene.hasElement("gone-1")).toBe(false);
    expect(scene.hasElement("blank-1")).toBe(false);

    // the source was only read
    expect(JSON.stringify(source.readScene())).toBe(before);
    // the journal holds no secret in clear
    const record = records.get(SOURCE_ID)!;
    expect(record.stage).toBe("committed");
    expect(JSON.stringify(record)).not.toContain(link.rootKey);
    expect(JSON.stringify(record)).not.toContain(link.invitationCapability);
  });

  it("is idempotent once committed", async () => {
    const { backend, deps } = setup();
    const first = await migrateVaultToV2(makeSource(), deps);
    const second = await migrateVaultToV2(makeSource(), deps);
    expect(second.vaultId).toBe(first.vaultId);
    expect(second.editorLink).toBe(first.editorLink);
    expect(second.resumed).toBe(true);
    expect(backend.count("create:")).toBe(1);
    expect(backend.room(first.vaultId).snapshot!.generation).toBe(1);
  });

  it("resumes after a crash once the Vault exists, without a second create", async () => {
    const { backend, records, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow("crash after created");
    expect(records.get(SOURCE_ID)!.stage).toBe("created");

    const result = await migrateVaultToV2(makeSource(), deps);
    expect(result.resumed).toBe(true);
    expect(result.migratedElements).toBe(5);
    expect(backend.count("create:")).toBe(1);
    expect(backend.room(result.vaultId).snapshot!.generation).toBe(1);
    expect(records.get(SOURCE_ID)!.stage).toBe("committed");
  });

  it("recognises its own snapshot when the commit ack was lost", async () => {
    const { backend, deps } = setup();
    let lose = true;
    const lossy: VaultV2MigrationDependencies = {
      ...deps,
      createSnapshotStore: (input) => {
        const store = deps.createSnapshotStore(input);
        return {
          load: store.load,
          cas: async (args) => {
            const result = await store.cas(args);
            if (lose) {
              lose = false;
              throw new VaultError("VAULT_PERSISTENCE_UNAVAILABLE", "lost", {
                recoverable: true,
              });
            }
            return result;
          },
        };
      },
    };
    await expect(migrateVaultToV2(makeSource(), lossy)).rejects.toMatchObject({
      code: "VAULT_PERSISTENCE_UNAVAILABLE",
    });
    const result = await migrateVaultToV2(makeSource(), lossy);
    const room = backend.room(result.vaultId);
    // no second generation: the stored snapshot was recognised as ours
    expect(room.snapshot!.generation).toBe(1);
    expect(backend.count("create:")).toBe(1);
  });

  it("discards a Vault whose creation outcome is unknown and starts over", async () => {
    const { backend, records, deps } = setup();
    backend.hangActivate = true;
    // the first run hangs inside create (tab killed); never awaited
    void migrateVaultToV2(makeSource(), deps);
    await vi.waitFor(() => expect(backend.count("activate:")).toBe(1));
    expect(records.get(SOURCE_ID)!.stage).toBe("creating");
    const abandoned = [...backend.vaults.keys()][0];

    backend.hangActivate = false;
    const result = await migrateVaultToV2(makeSource(), deps);
    expect(result.vaultId).not.toBe(abandoned);
    expect(backend.vaults.get(abandoned)).toBe("failed");
    expect(backend.vaults.get(result.vaultId)).toBe("active");
    expect(backend.room(result.vaultId).snapshot!.generation).toBe(1);
  });

  it("never overwrites a generation-1 snapshot it did not write", async () => {
    const { backend, records, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow();
    const vaultId = [...backend.vaults.keys()][0];
    const foreign = {
      generation: 1,
      snapshotId: "someone-else",
      envelopes: [],
    };
    backend.room(vaultId).snapshot = foreign;

    await expect(migrateVaultToV2(makeSource(), deps)).rejects.toMatchObject({
      code: "VAULT_SNAPSHOT_CONFLICT",
    });
    expect(backend.room(vaultId).snapshot).toBe(foreign);
    expect(records.get(SOURCE_ID)!.stage).toBe("created");
  });

  it("refuses before creating anything: viewer, attachments, unknown types", async () => {
    const { backend, records, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource({ role: "viewer" }), deps),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_FORBIDDEN" });

    const image = withId(
      {
        ...newElement({ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }),
        type: "image",
        fileId: "file-1",
        status: "saved",
        scale: [1, 1],
        crop: null,
      } as unknown as ExcalidrawElement,
      "image-1",
      "a0",
    );
    await expect(
      migrateVaultToV2(
        makeSource({ readScene: () => ({ elements: [image], appState: {} }) }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "VAULT_PROTOCOL_UNSUPPORTED" });

    const odd = { ...image, type: "hologram" } as unknown as ExcalidrawElement;
    await expect(
      migrateVaultToV2(
        makeSource({ readScene: () => ({ elements: [odd], appState: {} }) }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "VAULT_PROTOCOL_UNSUPPORTED" });

    expect(backend.calls).toEqual([]);
    expect(records.size).toBe(0);
  });

  it("compensates and forgets the attempt when creation fails", async () => {
    const { backend, records, deps } = setup({
      createV2: async () => {
        throw new VaultError("VAULT_RATE_LIMITED", "slow down", {
          recoverable: true,
        });
      },
    });
    await expect(migrateVaultToV2(makeSource(), deps)).rejects.toMatchObject({
      code: "VAULT_RATE_LIMITED",
    });
    expect(records.size).toBe(0);
    expect(backend.vaults.size).toBe(0);
  });
});

describe("migrateVaultToV2 · images (W5)", () => {
  let dbIndex = 0;
  const withAssets = async (
    server: FakeAssetServer,
    overrides: Partial<VaultV2MigrationDependencies> = {},
  ) => {
    const store = await VaultLocalStore.open({
      databaseName: `vault-v2-migration-assets-${++dbIndex}-${Date.now()}`,
    });
    const env = setup({
      assets: { service: server.service, store, isOnline: () => true },
      ...overrides,
    });
    return { ...env, store };
  };
  const imageSource = (
    files: Record<string, unknown> = { [TEST_FILE_ID]: imageFile() },
  ) =>
    makeSource({
      readScene: () => ({
        elements: [
          ...buildBasicScene(),
          withId(imageElement("img-1", TEST_FILE_ID, "saved"), "img-1", "a9"),
        ] as ExcalidrawElement[],
        appState: {},
      }),
      readFiles: () => files as never,
    });

  it("re-encrypts every image into the new Vault before committing", async () => {
    const server = new FakeAssetServer();
    const { backend, deps, store } = await withAssets(server);
    const result = await migrateVaultToV2(imageSource(), deps);

    const { scene, link } = await readMigrated(backend, result);
    const object = server.objects.get(`${result.vaultId}/${TEST_FILE_ID}`)!;
    expect(object.envelope.vaultId).toBe(result.vaultId);
    expect(
      await decryptVaultFile({
        vaultId: result.vaultId,
        rootKey: link.rootKey,
        fileId: TEST_FILE_ID,
        envelope: object.envelope,
      }),
    ).toMatchObject({ dataURL: imageFile().dataURL });
    // and the source key cannot open it
    await expect(
      decryptVaultFile({
        vaultId: result.vaultId,
        rootKey: SOURCE_KEY,
        fileId: TEST_FILE_ID,
        envelope: object.envelope,
      }),
    ).rejects.toMatchObject({ code: "VAULT_DECRYPT_FAILED" });
    const image = new VaultSceneMaterializer(scene)
      .materialize()
      .elements.find((element) => element.id === "img-1") as any;
    expect(image).toMatchObject({ fileId: TEST_FILE_ID, status: "saved" });
    store.close();
  });

  it("refuses an image whose file is not loaded, before creating anything", async () => {
    const server = new FakeAssetServer();
    const { backend, records, deps, store } = await withAssets(server);
    await expect(migrateVaultToV2(imageSource({}), deps)).rejects.toMatchObject(
      { code: "VAULT_NOT_FOUND" },
    );
    expect(backend.calls).toEqual([]);
    expect(records.size).toBe(0);
    store.close();
  });

  it("does not commit while an image is not uploaded; resumes with the same ciphertext", async () => {
    const server = new FakeAssetServer();
    server.offline = true;
    const { backend, records, deps, store } = await withAssets(server);
    await expect(migrateVaultToV2(imageSource(), deps)).rejects.toMatchObject({
      code: "VAULT_PERSISTENCE_UNAVAILABLE",
    });
    const vaultId = [...backend.vaults.keys()][0];
    expect(records.get(SOURCE_ID)!.stage).toBe("created");
    expect(backend.room(vaultId).snapshot).toBeNull();
    const [task] = await store.listAttachmentTasks({
      vaultId,
      roomId: ROOM_ID,
    });

    server.offline = false;
    const result = await migrateVaultToV2(imageSource(), deps);
    expect(result.vaultId).toBe(vaultId);
    expect(backend.room(vaultId).snapshot!.generation).toBe(1);
    expect(
      server.objects.get(`${vaultId}/${TEST_FILE_ID}`)!.encryptedDigest,
    ).toBe(task.encryptedDigest);
    store.close();
  });

  it("blocks on an asset digest conflict and never commits", async () => {
    const server = new FakeAssetServer();
    const { backend, deps, store } = await withAssets(server);
    await expect(
      migrateVaultToV2(imageSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow();
    const vaultId = [...backend.vaults.keys()][0];
    // someone else's bytes already sit under that fileId
    const other = await server.service.upload({
      vaultId,
      invitationCapability: "x",
      fileId: TEST_FILE_ID,
      envelope: await encryptVaultFile({
        vaultId,
        rootKey: SOURCE_KEY,
        file: imageFile(),
      }),
    });
    expect(other.fileId).toBe(TEST_FILE_ID);

    await expect(migrateVaultToV2(imageSource(), deps)).rejects.toMatchObject({
      code: "VAULT_ASSET_CONFLICT",
    });
    expect(backend.room(vaultId).snapshot).toBeNull();
    store.close();
  });
});

describe("migration journal (W4)", () => {
  it("cancel discards an unfinished migration; a committed one is refused", async () => {
    const { backend, records, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow();
    const vaultId = [...backend.vaults.keys()][0];

    await cancelVaultV2Migration(makeSource(), deps);
    expect(records.size).toBe(0);
    expect(backend.vaults.get(vaultId)).toBe("deleted");

    await migrateVaultToV2(makeSource(), deps);
    await expect(
      cancelVaultV2Migration(makeSource(), deps),
    ).rejects.toMatchObject({ code: "VAULT_ALREADY_EXISTS" });
    expect(records.get(SOURCE_ID)!.stage).toBe("committed");
  });

  it("only exposes the new link once committed", async () => {
    const { journal, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow();
    expect(await readVaultV2Migration(makeSource(), journal)).toMatchObject({
      stage: "created",
      editorLink: null,
    });
    const result = await migrateVaultToV2(makeSource(), deps);
    expect(
      await readVaultV2Migration(
        makeSource(),
        journal,
        "https://calileon.com/",
      ),
    ).toEqual({
      stage: "committed",
      vaultId: result.vaultId,
      editorLink: result.editorLink,
    });
    expect(
      await readVaultV2Migration(
        { vaultId: result.vaultId, rootKey: SOURCE_KEY },
        journal,
      ),
    ).toBeNull();
  });

  it("cannot be read without the source key, nor its stage forged", async () => {
    const { journal, records, deps } = setup();
    await expect(
      migrateVaultToV2(makeSource(), { ...deps, onStage: crashAt("created") }),
    ).rejects.toThrow();
    await expect(
      readVaultV2Migration(
        { vaultId: SOURCE_ID, rootKey: `${"E".repeat(42)}A` },
        journal,
      ),
    ).rejects.toMatchObject({ code: "VAULT_DECRYPT_FAILED" });

    // promoting the clear stage to "committed" breaks the AAD
    const record = records.get(SOURCE_ID)!;
    records.set(SOURCE_ID, { ...record, stage: "committed" });
    await expect(migrateVaultToV2(makeSource(), deps)).rejects.toMatchObject({
      code: "VAULT_DECRYPT_FAILED",
    });
    // and the entry is kept, not dropped
    expect(records.has(SOURCE_ID)).toBe(true);
  });

  it("persists in IndexedDB (local DB v2) and rejects a corrupt entry", async () => {
    expect(VAULT_V2_LOCAL_DB_VERSION).toBe(2);
    const databaseName = `vault-v2-migration-${Date.now()}`;
    const store = await VaultV2LocalStore.open({ databaseName });
    const { deps } = setup({ journal: store.migrations() });
    const result = await migrateVaultToV2(makeSource(), deps);
    store.close();

    const reopened = await VaultV2LocalStore.open({ databaseName });
    const journal = reopened.migrations();
    expect(await readVaultV2Migration(makeSource(), journal)).toMatchObject({
      stage: "committed",
      vaultId: result.vaultId,
    });
    await journal.put({
      ...(await journal.get(SOURCE_ID))!,
      stage: "bogus" as never,
    });
    await expect(journal.get(SOURCE_ID)).rejects.toMatchObject({
      code: "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
    });
    await journal.delete(SOURCE_ID);
    expect(await journal.get(SOURCE_ID)).toBeNull();
    reopened.close();
  });

  it("upgrades a version-1 local database in place", async () => {
    const databaseName = `vault-v2-upgrade-${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(databaseName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("outbox", {
          keyPath: ["vaultId", "updateId"],
        });
        req.result.createObjectStore("docs", { keyPath: "vaultId" });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const store = await VaultV2LocalStore.open({ databaseName });
    expect(await store.migrations().get(SOURCE_ID)).toBeNull();
    expect(await store.outbox(SOURCE_ID).list()).toEqual([]);
    store.close();
  });
});
