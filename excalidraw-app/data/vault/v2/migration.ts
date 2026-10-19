/**
 * Vault v2 (P4c) W4 migration, ADR 0030 §5 / decision 4-A: read-only import
 * of a v1 Vault into a NEW v2 Vault.
 *
 * - The v1 Vault is only *read*: the caller hands in the decrypted scene it
 *   already shows. This module has no v1 write API in reach, so the old
 *   snapshot, outbox, attachments and links stay byte-for-byte as they were
 *   and the user can always go back to them.
 * - The new Vault gets a new vaultId, root key and editor capability; its
 *   document is built by ONE writer (actor `migration:<id>`) and committed as
 *   generation 1 with CAS(expected 0).
 * - Crash-resumable via a local journal keyed by the source vaultId, sealed
 *   under the source root key (only a holder of the v1 link can read/resume
 *   it; the stage is bound into the AAD):
 *     creating  → identity journaled, create RPC outcome unknown
 *     created   → Vault active, snapshot not (known to be) committed
 *     committed → done; the journal is the pointer to the new link
 *   A resumed `creating` discards the half-made Vault and starts over; a
 *   resumed `created` first checks whether its own snapshot already landed
 *   (snapshot meta carries the migrationId). A generation-1 snapshot that is
 *   not ours is never overwritten → VAULT_SNAPSHOT_CONFLICT (blocked).
 * - Attachments (W5): every image file of the scene is re-encrypted under
 *   the new root key and uploaded through the durable P4b attachment queue
 *   *before* the snapshot is committed, so a committed new Vault never
 *   references a missing file. The queue persists the ciphertext, so a
 *   resumed run re-sends identical bytes (same digest); a digest conflict
 *   is VAULT_ASSET_CONFLICT (blocked), quota/network is retryable. Without
 *   asset dependencies, or with a file not loaded in the source, a scene
 *   with images is refused before anything is created.
 */
import * as Y from "yjs";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { VAULT_KEY_DERIVATION_DOMAIN, VAULT_SECRET_BYTES } from "../constants";
import { createVaultAttachmentQueue } from "../attachmentQueue";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding";
import { VaultError } from "../errors";

import { VaultV2SceneController } from "./controller";
import { createVaultV2, generateVaultV2Identity } from "./creation";
import { getVaultV2Link } from "./link";
import {
  VAULT_V2_CHUNK_RAW_BYTES,
  VAULT_V2_ENVELOPE_VERSION,
  VAULT_V2_MAX_CHUNKS,
  VAULT_V2_PROTOCOL_VERSION,
  VAULT_V2_SCHEMA_VERSION,
  VaultV2Reassembler,
  createVaultV2Keys,
  createVaultV2MessageId,
  fromB64,
  openVaultV2,
  sealVaultV2Message,
  toB64,
} from "./protocol";
import { isSupportedElementType } from "./schema";
import { VaultSceneDoc } from "./sceneDoc";

import type { VaultV2Creator, VaultV2Identity } from "./creation";
import type {
  VaultV2MigrationJournal,
  VaultV2MigrationJournalRecord,
} from "./localStore";
import type { VaultV2Keys } from "./protocol";
import type { VaultV2SnapshotStore } from "./syncEngine";
import type { VaultEncryptedAssetService } from "../assets";
import type { VaultLocalStore } from "../local-store/store";
import type { VaultOwnerService } from "../owner";
import type { VaultRoomProvisionTransport } from "../roomProvision";
import type { VaultRole } from "../types";

export type VaultV2MigrationStage = VaultV2MigrationJournalRecord["stage"];

/** the opened v1 Vault, as the App already holds it (read-only) */
export type VaultV2MigrationSource = {
  readonly vaultId: string;
  /** v1 root key: decrypts nothing here, only seals the local journal */
  readonly rootKey: string;
  readonly role: VaultRole;
  /** current decrypted scene; re-read on resume */
  readScene: () => {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
  };
  /** the decrypted image files the scene shows (needed for images) */
  readFiles?: () => BinaryFiles;
};

export type VaultV2MigrationDependencies = {
  journal: VaultV2MigrationJournal;
  createV2: VaultV2Creator;
  owner: VaultOwnerService;
  rooms: VaultRoomProvisionTransport;
  createSnapshotStore: (input: {
    vaultId: string;
    invitationCapability: string;
  }) => VaultV2SnapshotStore;
  baseUrl?: string;
  now?: () => number;
  /** one migration per source Vault at a time (default: Web Locks if present) */
  lock?: <T>(name: string, body: () => Promise<T>) => Promise<T>;
  /** called after each journal write (tests inject crashes here) */
  onStage?: (stage: VaultV2MigrationStage) => void | Promise<void>;
  /** W5: copies image files into the new Vault (absent: images refused) */
  assets?: {
    service: VaultEncryptedAssetService;
    /** P4b local store: holds the durable upload tasks */
    store: VaultLocalStore;
    isOnline?: () => boolean;
  };
};

export type VaultV2MigrationResult = {
  readonly sourceVaultId: string;
  readonly vaultId: string;
  /** the new Vault's editor link: the only carrier of its secrets */
  readonly editorLink: string;
  readonly migratedElements: number;
  /** true when an earlier (interrupted or finished) run was picked up */
  readonly resumed: boolean;
};

/** sealed part of a journal record */
type SealedState = {
  migrationId: string;
  identity: VaultV2Identity;
  invitationId: string | null;
  activeRoomId: string | null;
  migratedElements: number;
};

// ------------------------------------------------------------------ journal crypto

const JOURNAL_INFO = `${VAULT_KEY_DERIVATION_DOMAIN}\0v2\0migration-journal`;

const journalKey = async (rootKey: string, sourceVaultId: string) => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64UrlToBytes(rootKey);
  } catch {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault secret.");
  }
  if (raw.byteLength !== VAULT_SECRET_BYTES) {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault secret.");
  }
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(
        `${VAULT_KEY_DERIVATION_DOMAIN}\0${VAULT_V2_PROTOCOL_VERSION}\0${sourceVaultId}`,
      ),
      info: new TextEncoder().encode(JOURNAL_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const journalAad = (sourceVaultId: string, stage: VaultV2MigrationStage) =>
  new TextEncoder().encode(`${JOURNAL_INFO}\0${sourceVaultId}\0${stage}`);

type JournalOwner = Pick<VaultV2MigrationSource, "vaultId" | "rootKey">;

const sealJournal = async (
  source: JournalOwner,
  stage: VaultV2MigrationStage,
  state: SealedState,
  now: number,
): Promise<VaultV2MigrationJournalRecord> => {
  const sourceVaultId = source.vaultId.toLowerCase();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: journalAad(sourceVaultId, stage) },
    await journalKey(source.rootKey, sourceVaultId),
    new TextEncoder().encode(JSON.stringify(state)),
  );
  return {
    sourceVaultId,
    stage,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    updatedAt: now,
  };
};

const isSealedState = (value: unknown): value is SealedState => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Record<string, unknown>;
  const identity = state.identity as Record<string, unknown> | undefined;
  return (
    typeof state.migrationId === "string" &&
    !!identity &&
    typeof identity.vaultId === "string" &&
    typeof identity.rootKey === "string" &&
    typeof identity.invitationCapability === "string" &&
    (state.invitationId === null || typeof state.invitationId === "string") &&
    (state.activeRoomId === null || typeof state.activeRoomId === "string") &&
    Number.isSafeInteger(state.migratedElements)
  );
};

const openJournal = async (
  source: JournalOwner,
  record: VaultV2MigrationJournalRecord,
): Promise<SealedState> => {
  const sourceVaultId = source.vaultId.toLowerCase();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(record.iv),
        additionalData: journalAad(sourceVaultId, record.stage),
      },
      await journalKey(source.rootKey, sourceVaultId),
      base64UrlToBytes(record.ciphertext),
    );
  } catch {
    // kept, not deleted: it may be the only pointer to a new Vault
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault migration journal could not be opened.",
    );
  }
  let state: unknown;
  try {
    state = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    state = null;
  }
  if (!isSealedState(state)) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Vault migration journal entry is invalid.",
    );
  }
  return state;
};

// ------------------------------------------------------------------ seeding

const isBlank = (text: string) => text.trim() === "";

/** what the new Vault holds: the visible scene (v1 delete history stays in v1) */
const liveElements = (elements: readonly ExcalidrawElement[]) =>
  elements.filter(
    (element) =>
      !element.isDeleted &&
      !(element.type === "text" && isBlank(element.originalText)),
  );

/**
 * Builds the new document (single writer) and checks that materializing it
 * reproduces the source scene: same ids, types and texts. Fail-closed before
 * anything is created remotely.
 */
const seedDocument = (
  source: VaultV2MigrationSource,
  input: { migrationId: string; sourceVaultId: string; withAssets: boolean },
) => {
  const scene = source.readScene();
  const loaded = source.readFiles?.() ?? {};
  const files = new Map<FileId, BinaryFileData>();
  const live = liveElements(scene.elements).map((element) => {
    if (!isSupportedElementType(element.type)) {
      throw new VaultError(
        "VAULT_PROTOCOL_UNSUPPORTED",
        "The scene has an element type Vault v2 cannot store.",
      );
    }
    if (element.type !== "image" || !element.fileId) {
      return element;
    }
    if (!input.withAssets) {
      throw new VaultError(
        "VAULT_PROTOCOL_UNSUPPORTED",
        "Migrating Vault attachments is not available.",
      );
    }
    const file = loaded[element.fileId];
    if (!file) {
      // an image is never migrated without its file
      throw new VaultError(
        "VAULT_NOT_FOUND",
        "An image of the scene is not loaded yet.",
        { recoverable: true },
      );
    }
    files.set(element.fileId, file);
    // uploaded before the commit, so it is on the server for every peer
    return { ...element, status: "saved" } as ExcalidrawElement;
  });
  const controller = new VaultV2SceneController({
    actorId: `migration:${input.migrationId}`,
  });
  controller.scene.transact(() => {
    controller.scene.initMeta("migration", {
      sourceVaultId: input.sourceVaultId,
      migrationId: input.migrationId,
    });
    controller.captureLocal(live, scene.appState);
  });
  const materialized = new Map(
    controller.materializer
      .materialize()
      .elements.filter((element) => !element.isDeleted)
      .map((element) => [element.id, element]),
  );
  const faithful =
    materialized.size === live.length &&
    live.every((element) => {
      const copy = materialized.get(element.id);
      return (
        !!copy &&
        copy.type === element.type &&
        (element.type !== "text" ||
          (copy.type === "text" && copy.originalText === element.originalText))
      );
    });
  if (!faithful) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "The migrated scene does not match its source.",
    );
  }
  // inner JSON double-encodes the state (×1.78, ADR 0030 §6); refuse early
  const estimated = Math.ceil(
    (controller.scene.encodeStateAsUpdate().byteLength * 4) / 3 + 1024,
  );
  if (estimated > VAULT_V2_CHUNK_RAW_BYTES * VAULT_V2_MAX_CHUNKS) {
    throw new VaultError(
      "VAULT_PAYLOAD_TOO_LARGE",
      "The scene is too large for a Vault v2 snapshot.",
    );
  }
  return { scene: controller.scene, migratedElements: live.length, files };
};

/**
 * Re-encrypts and uploads every image file into the new Vault (W5). Throws
 * unless all of them have a verified receipt.
 */
const uploadAssets = async (
  assets: NonNullable<VaultV2MigrationDependencies["assets"]>,
  state: SealedState,
  files: ReadonlyMap<FileId, BinaryFileData>,
) => {
  if (files.size === 0) {
    return;
  }
  const queue = createVaultAttachmentQueue({
    store: assets.store,
    service: assets.service,
    vaultId: state.identity.vaultId,
    roomId: state.activeRoomId!,
    invitationCapability: state.identity.invitationCapability,
    rootKey: state.identity.rootKey,
    role: "editor",
    isOnline: assets.isOnline ?? (() => globalThis.navigator?.onLine !== false),
  });
  try {
    for (const [fileId, file] of files) {
      // idempotent: an existing task keeps its ciphertext (same digest)
      await queue.enqueue({ fileId, file });
    }
    await queue.drain();
    const tasks = new Map(
      (await queue.listTasks()).map((task) => [task.fileId, task]),
    );
    for (const fileId of files.keys()) {
      const task = tasks.get(fileId);
      if (task?.status === "complete") {
        continue;
      }
      if (
        task?.status === "failed" &&
        task.errorCode &&
        task.errorCode !== "VAULT_PERSISTENCE_UNAVAILABLE" &&
        task.errorCode !== "VAULT_RATE_LIMITED"
      ) {
        // e.g. VAULT_ASSET_CONFLICT or a lost capability: blocked
        throw new VaultError(
          task.errorCode,
          "A Vault image could not be copied.",
        );
      }
      throw new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault images are not uploaded yet.",
        { recoverable: true },
      );
    }
  } finally {
    queue.dispose();
  }
};

// ------------------------------------------------------------------ remote steps

/** migrationId recorded in a stored snapshot, or null if none / unreadable */
const snapshotMigrationId = async (
  keys: VaultV2Keys,
  loaded: NonNullable<Awaited<ReturnType<VaultV2SnapshotStore["load"]>>>,
): Promise<string | null> => {
  const reassembler = new VaultV2Reassembler(Number.MAX_SAFE_INTEGER);
  const scene = new VaultSceneDoc({ actorId: "migration-check" });
  try {
    for (const raw of loaded.envelopes) {
      const { envelope, plaintext } = await openVaultV2(keys, raw);
      const inner = reassembler.accept(envelope, plaintext);
      if (inner?.kind === "sync.snapshot") {
        scene.applyRemoteUpdate(fromB64(inner.state));
      }
    }
  } catch {
    return null;
  }
  const id = scene.meta.get("migrationId");
  return typeof id === "string" ? id : null;
};

/** commits generation 1 unless our own snapshot is already there */
const commitSnapshot = async (
  deps: VaultV2MigrationDependencies,
  state: SealedState,
  /** builds the document and uploads its files; only when not committed */
  prepare: () => Promise<VaultSceneDoc>,
) => {
  const { identity } = state;
  const keys = createVaultV2Keys(identity.rootKey, identity.vaultId);
  const store = deps.createSnapshotStore({
    vaultId: identity.vaultId,
    invitationCapability: identity.invitationCapability,
  });
  const alreadyOurs = async () => {
    const loaded = await store.load();
    if (!loaded) {
      return false;
    }
    if (
      loaded.generation >= 1 &&
      (await snapshotMigrationId(keys, loaded)) === state.migrationId
    ) {
      return true;
    }
    // never overwrite a branch we did not write (ADR 0030 §5)
    throw new VaultError(
      "VAULT_SNAPSHOT_CONFLICT",
      "The new Vault already holds a snapshot that is not this migration.",
    );
  };
  if (await alreadyOurs()) {
    return;
  }
  const scene = await prepare();
  const inner = {
    kind: "sync.snapshot" as const,
    snapshotId: createVaultV2MessageId(),
    authorActorId: scene.actorId,
    authorClock: scene.observedMaxClock,
    generation: 1,
    stateVector: toB64(Y.encodeStateVector(scene.doc)),
    state: toB64(Y.encodeStateAsUpdate(scene.doc)),
  };
  const envelopes = await sealVaultV2Message(
    keys,
    {
      version: VAULT_V2_ENVELOPE_VERSION,
      schemaVersion: VAULT_V2_SCHEMA_VERSION,
      protocolVersion: VAULT_V2_PROTOCOL_VERSION,
      vaultId: identity.vaultId,
      roomId: state.activeRoomId!,
      messageType: "snapshot.scene",
      generation: 1,
    },
    inner,
  );
  const result = await store.cas({
    expectedGeneration: 0,
    snapshotId: inner.snapshotId,
    envelopes,
  });
  if (!result.ok && !(await alreadyOurs())) {
    throw new VaultError(
      "VAULT_SNAPSHOT_CONFLICT",
      "The new Vault snapshot could not be committed.",
    );
  }
};

/**
 * Best-effort removal of a new Vault whose migration did not finish:
 * `creating` → failed; `active` → revoked → deleted. Errors are swallowed —
 * an orphan is an empty Vault of the same owner, never data loss.
 */
const discardNewVault = async (owner: VaultOwnerService, vaultId: string) => {
  try {
    await owner.failCreation(vaultId);
    return;
  } catch {
    // not (or no longer) creating
  }
  try {
    await owner.revokeVault(vaultId);
    await owner.softDeleteVault(vaultId);
  } catch {
    // never created, or already gone
  }
};

const defaultLock = <T>(name: string, body: () => Promise<T>): Promise<T> => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) {
    return body();
  }
  return locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      throw new VaultError(
        "VAULT_SNAPSHOT_CONFLICT",
        "This Vault is already being migrated in another tab.",
        { recoverable: true },
      );
    }
    return body();
  }) as Promise<T>;
};

// ------------------------------------------------------------------ public API

const resultOf = (
  source: JournalOwner,
  state: SealedState,
  baseUrl: string | undefined,
  resumed: boolean,
): VaultV2MigrationResult =>
  Object.freeze({
    sourceVaultId: source.vaultId.toLowerCase(),
    vaultId: state.identity.vaultId,
    editorLink: getVaultV2Link(
      {
        vaultId: state.identity.vaultId,
        rootKey: state.identity.rootKey,
        invitationCapability: state.identity.invitationCapability,
      },
      baseUrl,
    ),
    migratedElements: state.migratedElements,
    resumed,
  });

/**
 * Migrates (or resumes migrating) one v1 Vault. Idempotent: once committed,
 * every further call returns the same new Vault.
 */
export const migrateVaultToV2 = async (
  source: VaultV2MigrationSource,
  deps: VaultV2MigrationDependencies,
): Promise<VaultV2MigrationResult> => {
  if (source.role !== "editor") {
    throw new VaultError(
      "VAULT_CAPABILITY_FORBIDDEN",
      "Only an editor of a Vault can migrate it.",
    );
  }
  const sourceVaultId = source.vaultId.toLowerCase();
  const now = deps.now ?? Date.now;
  const lock = deps.lock ?? defaultLock;
  return lock(`vault-v2-migration:${sourceVaultId}`, async () => {
    const write = async (stage: VaultV2MigrationStage, state: SealedState) => {
      await deps.journal.put(await sealJournal(source, stage, state, now()));
      await deps.onStage?.(stage);
    };
    const existing = await deps.journal.get(sourceVaultId);
    let state = existing ? await openJournal(source, existing) : null;
    const resumed = state !== null;

    if (existing?.stage === "committed" && state) {
      return resultOf(source, state, deps.baseUrl, true);
    }
    if (existing?.stage === "creating" && state) {
      // the create outcome is unknown: drop that Vault and start over
      await discardNewVault(deps.owner, state.identity.vaultId);
      await deps.journal.delete(sourceVaultId);
      state = null;
    }

    let seeded: ReturnType<typeof seedDocument> | null = null;
    if (!state) {
      const migrationId = createVaultV2MessageId();
      seeded = seedDocument(source, {
        migrationId,
        sourceVaultId,
        withAssets: !!deps.assets,
      });
      const identity = generateVaultV2Identity();
      state = {
        migrationId,
        identity,
        invitationId: null,
        activeRoomId: null,
        migratedElements: seeded.migratedElements,
      };
      await write("creating", state);
      let created;
      try {
        created = await createVaultV2({
          createV2: deps.createV2,
          owner: deps.owner,
          rooms: deps.rooms,
          baseUrl: deps.baseUrl,
          identity,
        });
      } catch (error) {
        await discardNewVault(deps.owner, identity.vaultId);
        await deps.journal.delete(sourceVaultId);
        throw error;
      }
      state = {
        ...state,
        invitationId: created.invitationId,
        activeRoomId: created.activeRoomId,
      };
      await write("created", state);
    }

    const current = state;
    await commitSnapshot(deps, current, async () => {
      if (!seeded) {
        // resumed: rebuild from the source as it is now (still unchanged v1)
        seeded = seedDocument(source, {
          migrationId: current.migrationId,
          sourceVaultId,
          withAssets: !!deps.assets,
        });
        current.migratedElements = seeded.migratedElements;
      }
      if (deps.assets) {
        await uploadAssets(deps.assets, current, seeded.files);
      }
      return seeded.scene;
    });
    await write("committed", current);
    return resultOf(source, current, deps.baseUrl, resumed);
  });
};

/** the migration state of a v1 Vault on this device (for the read-only prompt) */
export const readVaultV2Migration = async (
  source: JournalOwner,
  journal: VaultV2MigrationJournal,
  baseUrl?: string,
): Promise<{
  stage: VaultV2MigrationStage;
  vaultId: string;
  /** only once committed */
  editorLink: string | null;
} | null> => {
  const record = await journal.get(source.vaultId);
  if (!record) {
    return null;
  }
  const state = await openJournal(source, record);
  return {
    stage: record.stage,
    vaultId: state.identity.vaultId,
    editorLink:
      record.stage === "committed"
        ? resultOf(source, state, baseUrl, true).editorLink
        : null,
  };
};

/**
 * Abandons an unfinished migration (the v1 Vault was never touched, so this
 * is the whole rollback). A committed one is refused: its journal is the
 * pointer to the new Vault, which its owner deletes like any other.
 */
export const cancelVaultV2Migration = async (
  source: JournalOwner,
  deps: Pick<VaultV2MigrationDependencies, "journal" | "owner" | "lock">,
): Promise<void> => {
  const sourceVaultId = source.vaultId.toLowerCase();
  const lock = deps.lock ?? defaultLock;
  await lock(`vault-v2-migration:${sourceVaultId}`, async () => {
    const record = await deps.journal.get(sourceVaultId);
    if (!record) {
      return;
    }
    if (record.stage === "committed") {
      throw new VaultError(
        "VAULT_ALREADY_EXISTS",
        "This Vault has already been migrated.",
      );
    }
    const state = await openJournal(source, record);
    await discardNewVault(deps.owner, state.identity.vaultId);
    await deps.journal.delete(sourceVaultId);
  });
};
