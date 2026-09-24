import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { base64UrlToBytes } from "./encoding";
import { VaultError } from "./errors";
import { createVaultOutboxController } from "./outbox";
import { createVaultPersistenceService } from "./persistence";
import { encryptVaultSnapshot } from "./snapshot";
import { VaultLocalStore } from "./local-store/store";
import {
  openVaultLocalDatabase,
  VAULT_LOCAL_OUTBOX_STORE,
} from "./local-store";

import type { VaultPersistenceServiceImplementation } from "./persistence";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const roomId = "vault_room_1234567890";
const capability = "B".repeat(43);

const deployment = assertVaultDeploymentReady(
  {
    enabled: true,
    protocolVersions: [1],
    roomProtocolVersions: [1],
    invitationService: true,
    encryptedSnapshotPersistence: true,
    encryptedAssetPersistence: true,
  },
  { isSecureContext: true, hasWebCrypto: true },
);

let databaseCounter = 0;
const databaseName = () =>
  `excalidraw-vault-outbox-test-${Date.now()}-${databaseCounter++}`;

const deleteDatabase = (name: string) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });

const readRawOutbox = async (name: string) => {
  const db = await openVaultLocalDatabase({ databaseName: name });
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = db
      .transaction(VAULT_LOCAL_OUTBOX_STORE, "readonly")
      .objectStore(VAULT_LOCAL_OUTBOX_STORE)
      .getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records;
};

const createPersistence = (
  overrides: Partial<VaultPersistenceServiceImplementation> = {},
) =>
  createVaultPersistenceService(deployment, {
    resolveCapability: vi.fn(),
    loadSnapshot: vi.fn(),
    casSnapshot: vi.fn(),
    registerAsset: vi.fn(),
    resolveAsset: vi.fn(),
    ...overrides,
  });

const seed = async (store: VaultLocalStore, rootKey: string) => {
  const envelope = await encryptVaultSnapshot({
    vaultId,
    rootKey,
    generation: 1,
    snapshot: { marker: "pending-local" },
  });
  const record = await store.createSnapshotOutboxRecord({
    vaultId,
    roomId,
    envelope,
    expectedGeneration: 0,
    createdAt: 10,
  });
  await store.putSnapshotAndOutbox({
    vaultId,
    roomId,
    rootKey,
    generation: 1,
    snapshot: { marker: "pending-local" },
    updatedAt: 10,
    outbox: record,
  });
  return record;
};

describe("Vault durable outbox", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("atomically persists the encrypted local snapshot and stable update ID", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const record = await seed(store, rootKey);

    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([
      expect.objectContaining({
        updateId: record.updateId,
        expectedGeneration: 0,
        status: "pending",
        ciphertextBytes: expect.any(Number),
        ciphertextDigest: expect.any(String),
      }),
    ]);
    const raw = JSON.stringify(await readRawOutbox(name));
    expect(raw).not.toContain("pending-local");
    expect(raw).not.toContain(rootKey);
    expect(raw).not.toContain(capability);
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({ generation: 1 });

    store.close();
    await deleteDatabase(name);
  });

  it("retries the same update ID and removes the record only after confirmation", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const record = await seed(store, rootKey);
    const casSnapshot = vi
      .fn()
      .mockRejectedValueOnce(
        new VaultError("VAULT_PERSISTENCE_UNAVAILABLE", "offline", {
          recoverable: true,
        }),
      )
      .mockResolvedValueOnce({
        vaultId,
        updateId: record.updateId,
        generation: 1,
        updatedAt: 20,
      });
    const controller = createVaultOutboxController({
      store,
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => true,
      retryBaseDelayMs: 0,
    });

    await expect(controller.drain()).resolves.toMatchObject([
      { status: "offline" },
    ]);
    await expect(controller.drain()).resolves.toMatchObject([
      { status: "confirmed" },
    ]);
    expect(casSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ updateId: record.updateId }),
    );
    expect(casSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ updateId: record.updateId }),
    );
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([]);

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("retains an offline outbox and recovers it after reopening the database", async () => {
    const name = databaseName();
    const rootKey = generateVaultRootKey();
    const firstStore = await VaultLocalStore.open({ databaseName: name });
    const record = await seed(firstStore, rootKey);
    firstStore.close();

    const offlineController = createVaultOutboxController({
      store: await VaultLocalStore.open({ databaseName: name }),
      persistence: createPersistence(),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => false,
    });
    await expect(offlineController.drain()).resolves.toMatchObject([
      { status: "offline" },
    ]);
    offlineController.dispose();

    const restartedStore = await VaultLocalStore.open({ databaseName: name });
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      updateId: record.updateId,
      generation: 1,
      updatedAt: 40,
    });
    const restartedController = createVaultOutboxController({
      store: restartedStore,
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => true,
    });
    await expect(restartedController.drain()).resolves.toMatchObject([
      { status: "confirmed" },
    ]);
    expect(casSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ updateId: record.updateId }),
    );
    await expect(
      restartedStore.listOutbox({ vaultId, roomId }),
    ).resolves.toEqual([]);

    restartedController.dispose();
    restartedStore.close();
    await deleteDatabase(name);
  });

  it("replays a sending record after an interrupted send", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const record = await seed(store, rootKey);
    await store.updateOutbox({ ...record, status: "sending", attempts: 1 });
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      updateId: record.updateId,
      generation: 1,
      updatedAt: 50,
    });
    const controller = createVaultOutboxController({
      store,
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => true,
    });
    await expect(controller.drain()).resolves.toMatchObject([
      { status: "confirmed" },
    ]);
    expect(casSnapshot).toHaveBeenCalledTimes(1);

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("stops retrying after capability revoke or expiry errors", async () => {
    for (const code of [
      "VAULT_CAPABILITY_REVOKED",
      "VAULT_CAPABILITY_EXPIRED",
    ] as const) {
      const name = databaseName();
      const store = await VaultLocalStore.open({ databaseName: name });
      await seed(store, generateVaultRootKey());
      const casSnapshot = vi.fn().mockRejectedValue(new VaultError(code, code));
      const controller = createVaultOutboxController({
        store,
        persistence: createPersistence({ casSnapshot }),
        vaultId,
        roomId,
        invitationCapability: capability,
        isOnline: () => true,
      });
      await expect(controller.drain()).resolves.toMatchObject([
        { status: "failed", errorCode: code },
      ]);
      await expect(controller.drain()).resolves.toEqual([
        expect.objectContaining({ status: "failed", errorCode: code }),
      ]);
      expect(casSnapshot).toHaveBeenCalledTimes(1);
      controller.dispose();
      store.close();
      await deleteDatabase(name);
    }
  });

  it("keeps outboxes isolated by room", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    await seed(store, rootKey);
    const otherRoom = "vault_room_other123";
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "other-room" },
    });
    const otherRecord = await store.createSnapshotOutboxRecord({
      vaultId,
      roomId: otherRoom,
      envelope,
      expectedGeneration: 0,
    });
    await store.putSnapshotAndOutbox({
      vaultId,
      roomId: otherRoom,
      rootKey,
      generation: 1,
      snapshot: { marker: "other-room" },
      outbox: otherRecord,
    });
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toHaveLength(
      1,
    );
    await expect(
      store.listOutbox({ vaultId, roomId: otherRoom }),
    ).resolves.toHaveLength(1);

    store.close();
    await deleteDatabase(name);
  });

  it("keeps local and remote encrypted branches on a generation conflict", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const record = await seed(store, rootKey);
    const remoteEnvelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "remote" },
    });
    const controller = createVaultOutboxController({
      store,
      persistence: createPersistence({
        casSnapshot: vi.fn().mockRejectedValue(
          new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
            recoverable: true,
          }),
        ),
        loadSnapshot: vi.fn().mockResolvedValue({
          vaultId,
          generation: 1,
          encryptedEnvelope: remoteEnvelope,
          ciphertextBytes: base64UrlToBytes(remoteEnvelope.ciphertext)
            .byteLength,
          updatedAt: 30,
        }),
      }),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => true,
    });

    await expect(controller.drain()).resolves.toMatchObject([
      {
        status: "conflict",
        record: expect.objectContaining({
          updateId: record.updateId,
          remoteGeneration: 1,
          conflictReason: "generation",
        }),
        latest: expect.objectContaining({ generation: 1 }),
      },
    ]);
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toMatchObject([
      expect.objectContaining({ status: "conflict" }),
    ]);

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("does not advance generation when the same update ID is confirmed again", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const record = await seed(store, rootKey);
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      updateId: record.updateId,
      generation: 1,
      updatedAt: 60,
    });
    const controller = createVaultOutboxController({
      store,
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      roomId,
      invitationCapability: capability,
      isOnline: () => true,
    });

    await expect(controller.drain()).resolves.toMatchObject([
      { status: "confirmed", result: { generation: 1 } },
    ]);
    expect(casSnapshot).toHaveBeenCalledTimes(1);

    // The confirmed record is removed, so replaying the same update ID is a
    // no-op: no second CAS and no second generation advance.
    await expect(controller.send(record.updateId)).resolves.toBeNull();
    expect(casSnapshot).toHaveBeenCalledTimes(1);
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([]);
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({ generation: 1 });

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });
});
