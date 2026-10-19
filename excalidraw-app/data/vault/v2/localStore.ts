/**
 * Vault v2 (P4c) local persistence, W3: durable outbox + local Yjs doc.
 *
 * Own IndexedDB database, so the v1 local store (`excalidraw-vault-local`)
 * keeps its schema and upgrade path untouched.
 *
 * Nothing is stored in plaintext:
 * - outbox entries already hold sealed envelopes (exactly what goes on the
 *   wire, so a resend is a byte-identical replay that receivers dedupe);
 * - the local doc is sealed as a `snapshot.scene` message with the Vault's v2
 *   snapshot key, i.e. the same AEAD binding (vaultId, roomId, generation) as
 *   a server snapshot. It is a cache: losing it only costs a reload.
 */
import * as Y from "yjs";

import { VaultError } from "../errors";

import {
  VAULT_V2_ENVELOPE_VERSION,
  VAULT_V2_PROTOCOL_VERSION,
  VAULT_V2_SCHEMA_VERSION,
  VaultV2Reassembler,
  assertVaultEnvelopeV2,
  createVaultV2MessageId,
  fromB64,
  openVaultV2,
  sealVaultV2Message,
  toB64,
} from "./protocol";

import type { VaultEnvelopeV2, VaultV2Keys } from "./protocol";
import type { VaultSceneDoc } from "./sceneDoc";
import type { VaultV2Outbox, VaultV2OutboxEntry } from "./syncEngine";

export const VAULT_V2_LOCAL_DB_NAME = "excalidraw-vault-v2-local" as const;
// 2: + migrations (W4 journal)
export const VAULT_V2_LOCAL_DB_VERSION = 2 as const;
const OUTBOX_STORE = "outbox";
const DOC_STORE = "docs";
const MIGRATION_STORE = "migrations";

/**
 * W4 migration journal entry, keyed by the *source* (v1) Vault. Everything
 * but the stage is sealed by migration.ts under the source root key.
 */
export type VaultV2MigrationJournalRecord = {
  readonly sourceVaultId: string;
  readonly stage: "creating" | "created" | "committed";
  readonly iv: string;
  readonly ciphertext: string;
  readonly updatedAt: number;
};

/** the journal migration.ts runs on (IndexedDB here, in-memory in tests) */
export type VaultV2MigrationJournal = {
  get: (sourceVaultId: string) => Promise<VaultV2MigrationJournalRecord | null>;
  put: (record: VaultV2MigrationJournalRecord) => Promise<void>;
  delete: (sourceVaultId: string) => Promise<void>;
};

const isMigrationRecord = (
  value: unknown,
): value is VaultV2MigrationJournalRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sourceVaultId === "string" &&
    (record.stage === "creating" ||
      record.stage === "created" ||
      record.stage === "committed") &&
    typeof record.iv === "string" &&
    typeof record.ciphertext === "string" &&
    Number.isFinite(record.updatedAt)
  );
};

type OutboxRecord = VaultV2OutboxEntry & { vaultId: string };
type DocRecord = {
  vaultId: string;
  roomId: string;
  generation: number;
  savedAt: number;
  envelopes: readonly VaultEnvelopeV2[];
};

const unavailable = (message: string) =>
  new VaultError("VAULT_LOCAL_STORAGE_UNAVAILABLE", message, {
    recoverable: true,
  });

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(unavailable("Vault v2 local storage failed."));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(unavailable("Vault v2 local storage failed."));
    tx.onabort = () => reject(unavailable("Vault v2 local storage aborted."));
  });

const openDatabase = (factory: IDBFactory, name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, VAULT_V2_LOCAL_DB_VERSION);
    } catch {
      reject(unavailable("Vault v2 local database could not be opened."));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, {
          keyPath: ["vaultId", "updateId"],
        });
      }
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: "vaultId" });
      }
      if (!db.objectStoreNames.contains(MIGRATION_STORE)) {
        db.createObjectStore(MIGRATION_STORE, { keyPath: "sourceVaultId" });
      }
    };
    req.onerror = () =>
      reject(
        req.error?.name === "VersionError"
          ? new VaultError(
              "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
              "Unsupported Vault v2 local database schema.",
            )
          : unavailable("Vault v2 local database could not be opened."),
      );
    req.onblocked = () =>
      reject(unavailable("Vault v2 local database upgrade is blocked."));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });

const isOutboxRecord = (value: unknown, vaultId: string) => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.vaultId !== vaultId ||
    typeof record.updateId !== "string" ||
    !Number.isSafeInteger(record.clientId) ||
    !Number.isSafeInteger(record.clockAfter) ||
    !Array.isArray(record.envelopes)
  ) {
    return false;
  }
  try {
    record.envelopes.forEach((envelope) => assertVaultEnvelopeV2(envelope));
  } catch {
    return false;
  }
  return true;
};

export class VaultV2LocalStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    options: { indexedDB?: IDBFactory | null; databaseName?: string } = {},
  ) {
    const factory =
      options.indexedDB === undefined
        ? globalThis.indexedDB
        : options.indexedDB;
    if (!factory) {
      throw unavailable("IndexedDB is unavailable for Vault v2.");
    }
    return new VaultV2LocalStore(
      await openDatabase(
        factory,
        options.databaseName ?? VAULT_V2_LOCAL_DB_NAME,
      ),
    );
  }

  close() {
    this.db.close();
  }

  /** durable outbox for one Vault (the engine's `VaultV2Outbox`) */
  outbox(vaultId: string): VaultV2Outbox {
    const id = vaultId.toLowerCase();
    return {
      put: async (entry) => {
        const tx = this.db.transaction(OUTBOX_STORE, "readwrite");
        const record: OutboxRecord = {
          vaultId: id,
          updateId: entry.updateId,
          clientId: entry.clientId,
          clockAfter: entry.clockAfter,
          envelopes: entry.envelopes,
        };
        tx.objectStore(OUTBOX_STORE).put(record);
        await done(tx);
      },
      remove: async (updateIds) => {
        if (updateIds.length === 0) {
          return;
        }
        const tx = this.db.transaction(OUTBOX_STORE, "readwrite");
        const store = tx.objectStore(OUTBOX_STORE);
        for (const updateId of updateIds) {
          store.delete([id, updateId]);
        }
        await done(tx);
      },
      list: async () => {
        const tx = this.db.transaction(OUTBOX_STORE, "readonly");
        const records = await request(
          tx
            .objectStore(OUTBOX_STORE)
            .getAll(IDBKeyRange.bound([id, ""], [id, "￿"])),
        );
        // a corrupted record is skipped, not resent (it would be rejected)
        return (records as unknown[])
          .filter((record) => isOutboxRecord(record, id))
          .map((record) => {
            const { vaultId: _vaultId, ...entry } = record as OutboxRecord;
            return entry;
          });
      },
    };
  }

  /** W4 migration journal (records are sealed by the caller) */
  migrations(): VaultV2MigrationJournal {
    return {
      get: async (sourceVaultId) => {
        const tx = this.db.transaction(MIGRATION_STORE, "readonly");
        const record = await request(
          tx.objectStore(MIGRATION_STORE).get(sourceVaultId.toLowerCase()),
        );
        if (record === undefined) {
          return null;
        }
        if (!isMigrationRecord(record)) {
          // never dropped silently: it may be the only pointer to a new Vault
          throw new VaultError(
            "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
            "Vault v2 migration journal entry is invalid.",
          );
        }
        return record;
      },
      put: async (record) => {
        const tx = this.db.transaction(MIGRATION_STORE, "readwrite");
        tx.objectStore(MIGRATION_STORE).put({
          ...record,
          sourceVaultId: record.sourceVaultId.toLowerCase(),
        });
        await done(tx);
      },
      delete: async (sourceVaultId) => {
        const tx = this.db.transaction(MIGRATION_STORE, "readwrite");
        tx.objectStore(MIGRATION_STORE).delete(sourceVaultId.toLowerCase());
        await done(tx);
      },
    };
  }

  /** seals and stores the full doc state (W3 local copy) */
  async saveDoc(input: {
    keys: VaultV2Keys;
    vaultId: string;
    roomId: string;
    generation: number;
    scene: VaultSceneDoc;
    now?: number;
  }) {
    const { generation } = input;
    const envelopes = await sealVaultV2Message(
      input.keys,
      {
        version: VAULT_V2_ENVELOPE_VERSION,
        schemaVersion: VAULT_V2_SCHEMA_VERSION,
        protocolVersion: VAULT_V2_PROTOCOL_VERSION,
        vaultId: input.vaultId,
        roomId: input.roomId,
        messageType: "snapshot.scene",
        generation,
      },
      {
        kind: "sync.snapshot",
        snapshotId: createVaultV2MessageId(),
        authorActorId: input.scene.actorId,
        authorClock: input.scene.observedMaxClock,
        generation,
        stateVector: toB64(Y.encodeStateVector(input.scene.doc)),
        state: toB64(Y.encodeStateAsUpdate(input.scene.doc)),
      },
    );
    const record: DocRecord = {
      vaultId: input.vaultId.toLowerCase(),
      roomId: input.roomId,
      generation: input.generation,
      savedAt: input.now ?? Date.now(),
      envelopes,
    };
    const tx = this.db.transaction(DOC_STORE, "readwrite");
    tx.objectStore(DOC_STORE).put(record);
    await done(tx);
  }

  /**
   * Opens the local copy into `scene` (as a remote update, so it is not
   * re-published). Returns the server generation it was based on, or null
   * when there is no usable copy. An undecryptable or foreign copy is
   * dropped: the server snapshot is the source of truth.
   */
  async restoreDoc(input: {
    keys: VaultV2Keys;
    vaultId: string;
    roomId: string;
    scene: VaultSceneDoc;
  }): Promise<{ generation: number; savedAt: number } | null> {
    const vaultId = input.vaultId.toLowerCase();
    const tx = this.db.transaction(DOC_STORE, "readonly");
    const record = (await request(tx.objectStore(DOC_STORE).get(vaultId))) as
      | DocRecord
      | undefined;
    if (!record) {
      return null;
    }
    try {
      if (record.roomId !== input.roomId || !Array.isArray(record.envelopes)) {
        throw new VaultError("VAULT_ENVELOPE_INVALID", "foreign local copy");
      }
      const reassembler = new VaultV2Reassembler(Number.MAX_SAFE_INTEGER);
      let state: string | null = null;
      for (const raw of record.envelopes) {
        const { envelope, plaintext } = await openVaultV2(input.keys, raw);
        if (
          envelope.messageType !== "snapshot.scene" ||
          envelope.vaultId.toLowerCase() !== vaultId ||
          envelope.roomId !== input.roomId
        ) {
          throw new VaultError("VAULT_ENVELOPE_INVALID", "foreign local copy");
        }
        const inner = reassembler.accept(envelope, plaintext);
        if (inner?.kind === "sync.snapshot") {
          state = inner.state;
        }
      }
      if (state === null) {
        throw new VaultError("VAULT_ENVELOPE_INVALID", "incomplete local copy");
      }
      input.scene.applyRemoteUpdate(fromB64(state));
      return { generation: record.generation, savedAt: record.savedAt };
    } catch {
      await this.deleteDoc(vaultId);
      return null;
    }
  }

  async deleteDoc(vaultId: string) {
    const tx = this.db.transaction(DOC_STORE, "readwrite");
    tx.objectStore(DOC_STORE).delete(vaultId.toLowerCase());
    await done(tx);
  }

  /** forget everything about one Vault (revoke, leave, migration rollback) */
  async purgeVault(vaultId: string) {
    const id = vaultId.toLowerCase();
    const tx = this.db.transaction([OUTBOX_STORE, DOC_STORE], "readwrite");
    tx.objectStore(OUTBOX_STORE).delete(IDBKeyRange.bound([id, ""], [id, "￿"]));
    tx.objectStore(DOC_STORE).delete(id);
    await done(tx);
  }
}

/**
 * Debounced local saves: after doc changes (default 2 s) and on demand
 * (page hidden). Saves never overlap; a change during a save schedules one
 * more.
 */
export class VaultV2LocalDocSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;
  private readonly onUpdate = () => this.schedule();

  constructor(
    private readonly options: {
      store: VaultV2LocalStore;
      keys: VaultV2Keys;
      vaultId: string;
      roomId: string;
      scene: VaultSceneDoc;
      generation: () => number;
      debounceMs?: number;
      onError?: (error: unknown) => void;
    },
  ) {
    options.scene.doc.on("update", this.onUpdate);
  }

  private schedule() {
    if (this.disposed) {
      return;
    }
    this.dirty = true;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.options.debounceMs ?? 2_000);
    }
  }

  flush = async (): Promise<void> => {
    if (this.saving) {
      await this.saving;
    }
    if (!this.dirty || this.disposed) {
      return;
    }
    this.dirty = false;
    this.saving = this.options.store
      .saveDoc({
        keys: this.options.keys,
        vaultId: this.options.vaultId,
        roomId: this.options.roomId,
        generation: this.options.generation(),
        scene: this.options.scene,
      })
      .catch((error) => {
        this.dirty = true;
        this.options.onError?.(error);
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
  };

  dispose() {
    this.disposed = true;
    this.options.scene.doc.off("update", this.onUpdate);
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
