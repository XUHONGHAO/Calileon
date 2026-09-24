import { VaultError } from "../errors";
import { base64UrlToBytes } from "../encoding";
import { digestVaultAssetEnvelope } from "../fileAssets";

import {
  assertVaultLocalSnapshotRecord,
  assertVaultLocalOutboxRecord,
  assertVaultLocalAttachmentTaskRecord,
  assertVaultLocalScope,
  createVaultLocalRecordKey,
  VAULT_LOCAL_ATTACHMENT_TASK_STORE,
  VAULT_LOCAL_SCHEMA_VERSION,
  VAULT_LOCAL_OUTBOX_STORE,
  VAULT_LOCAL_SNAPSHOT_STORE,
  type VaultLocalAttachmentTaskRecord,
  type VaultLocalOutboxRecord,
  type VaultLocalSnapshotRecord,
} from "./domain";
import {
  decryptVaultLocalSnapshot,
  digestVaultLocalCiphertext,
  encryptVaultLocalSnapshot,
} from "./crypto";
import {
  openVaultLocalDatabase,
  runVaultLocalMultiStoreTransaction,
  runVaultLocalTransaction,
  type VaultLocalIndexedDbOptions,
} from "./indexeddb";

import type {
  VaultAssetEncryptedEnvelopeV1,
  VaultEncryptedEnvelopeV1,
} from "../types";

export interface VaultLocalSnapshotInput<TSnapshot> {
  vaultId: string;
  roomId: string;
  rootKey: string;
  generation: number;
  snapshot: TSnapshot;
  updatedAt?: number;
}

export interface VaultLocalSnapshotResult<TSnapshot> {
  snapshot: TSnapshot;
  generation: number;
  updatedAt: number;
}

export interface VaultLocalSnapshotAndOutboxInput<TSnapshot> {
  vaultId: string;
  roomId: string;
  rootKey: string;
  generation: number;
  snapshot: TSnapshot;
  updatedAt?: number;
  outbox: VaultLocalOutboxRecord;
}

const assertTimestamp = (updatedAt: number) => {
  if (!Number.isFinite(updatedAt)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot timestamp.",
    );
  }
};

export class VaultLocalStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(options: VaultLocalIndexedDbOptions = {}) {
    return new VaultLocalStore(await openVaultLocalDatabase(options));
  }

  close() {
    this.db.close();
  }

  async putSnapshot<TSnapshot>(
    input: VaultLocalSnapshotInput<TSnapshot>,
  ): Promise<VaultLocalSnapshotResult<TSnapshot>> {
    const updatedAt = input.updatedAt ?? Date.now();
    assertTimestamp(updatedAt);
    const envelope = await encryptVaultLocalSnapshot({
      vaultId: input.vaultId,
      roomId: input.roomId,
      rootKey: input.rootKey,
      generation: input.generation,
      snapshot: input.snapshot,
    });
    const record: VaultLocalSnapshotRecord = {
      key: createVaultLocalRecordKey(input.vaultId, input.roomId),
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      protocolVersion: 1,
      vaultId: input.vaultId,
      roomId: input.roomId,
      generation: input.generation,
      updatedAt,
      envelope,
    };
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_SNAPSHOT_STORE,
      "readwrite",
      (store) => store.put(record),
    );
    return {
      snapshot: input.snapshot,
      generation: input.generation,
      updatedAt,
    };
  }

  async putSnapshotAndOutbox<TSnapshot>(
    input: VaultLocalSnapshotAndOutboxInput<TSnapshot>,
  ): Promise<VaultLocalSnapshotResult<TSnapshot>> {
    const updatedAt = input.updatedAt ?? Date.now();
    assertTimestamp(updatedAt);
    const envelope = await encryptVaultLocalSnapshot({
      vaultId: input.vaultId,
      roomId: input.roomId,
      rootKey: input.rootKey,
      generation: input.generation,
      snapshot: input.snapshot,
    });
    const record: VaultLocalSnapshotRecord = {
      key: createVaultLocalRecordKey(input.vaultId, input.roomId),
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      protocolVersion: 1,
      vaultId: input.vaultId,
      roomId: input.roomId,
      generation: input.generation,
      updatedAt,
      envelope,
    };
    assertVaultLocalOutboxRecord(input.outbox);
    if (
      input.outbox.vaultId !== input.vaultId ||
      input.outbox.roomId !== input.roomId ||
      input.outbox.envelope.purpose !== "snapshot" ||
      input.outbox.envelope.generation !== input.generation
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault local snapshot/outbox scope mismatch.",
      );
    }
    await runVaultLocalMultiStoreTransaction(
      this.db,
      [VAULT_LOCAL_SNAPSHOT_STORE, VAULT_LOCAL_OUTBOX_STORE],
      "readwrite",
      (transaction) => {
        transaction.objectStore(VAULT_LOCAL_SNAPSHOT_STORE).put(record);
        transaction
          .objectStore(VAULT_LOCAL_OUTBOX_STORE)
          .put(input.outbox, input.outbox.updateId);
      },
    );
    return {
      snapshot: input.snapshot,
      generation: input.generation,
      updatedAt,
    };
  }

  async createSnapshotOutboxRecord(input: {
    vaultId: string;
    roomId: string;
    envelope: VaultEncryptedEnvelopeV1;
    expectedGeneration: number;
    createdAt?: number;
  }): Promise<VaultLocalOutboxRecord> {
    if (
      input.envelope.purpose !== "snapshot" ||
      input.envelope.vaultId !== input.vaultId ||
      input.envelope.messageType !== "snapshot.scene" ||
      input.envelope.generation !== input.expectedGeneration + 1
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Invalid Vault snapshot outbox envelope.",
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    assertTimestamp(createdAt);
    // The server contract measures decoded ciphertext bytes, not base64 text.
    const decodedCiphertextBytes = base64UrlToBytes(
      input.envelope.ciphertext,
    ).byteLength;
    const ciphertextDigest = await digestVaultLocalCiphertext(
      input.envelope.ciphertext,
    );
    const record: VaultLocalOutboxRecord = {
      updateId: input.envelope.messageId,
      vaultId: input.vaultId,
      roomId: input.roomId,
      kind: "snapshot.commit",
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      protocolVersion: 1,
      envelope: input.envelope,
      expectedGeneration: input.expectedGeneration,
      status: "pending",
      attempts: 0,
      createdAt,
      lastAttemptAt: null,
      acknowledgedAt: null,
      errorCode: null,
      ciphertextBytes: decodedCiphertextBytes,
      ciphertextDigest,
      remoteEnvelope: null,
      remoteGeneration: null,
      conflictReason: null,
    };
    assertVaultLocalOutboxRecord(record);
    return record;
  }

  async listOutbox(input: {
    vaultId: string;
    roomId: string;
  }): Promise<readonly VaultLocalOutboxRecord[]> {
    const records = await runVaultLocalTransaction<unknown[]>(
      this.db,
      VAULT_LOCAL_OUTBOX_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    const scoped: VaultLocalOutboxRecord[] = [];
    for (const value of records ?? []) {
      assertVaultLocalOutboxRecord(value);
      if (
        value.vaultId === input.vaultId &&
        value.roomId === input.roomId &&
        value.status !== "confirmed"
      ) {
        scoped.push(value);
      }
    }
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  async updateOutbox(record: VaultLocalOutboxRecord): Promise<void> {
    assertVaultLocalOutboxRecord(record);
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_OUTBOX_STORE,
      "readwrite",
      (store) => store.put(record, record.updateId),
    );
  }

  async deleteOutbox(input: {
    vaultId: string;
    roomId: string;
    updateId: string;
  }): Promise<void> {
    const record = await runVaultLocalTransaction<VaultLocalOutboxRecord>(
      this.db,
      VAULT_LOCAL_OUTBOX_STORE,
      "readonly",
      (store) => store.get(input.updateId),
    );
    if (record === undefined) {
      return;
    }
    assertVaultLocalOutboxRecord(record);
    if (record.vaultId !== input.vaultId || record.roomId !== input.roomId) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault local outbox scope mismatch.",
      );
    }
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_OUTBOX_STORE,
      "readwrite",
      (store) => store.delete(input.updateId),
    );
  }

  async enqueueAttachmentTask(input: {
    vaultId: string;
    roomId: string;
    fileId: string;
    envelope: VaultAssetEncryptedEnvelopeV1;
    taskId?: string;
    createdAt?: number;
  }): Promise<VaultLocalAttachmentTaskRecord> {
    assertVaultLocalScope(input.vaultId, input.roomId);
    if (
      input.envelope.purpose !== "asset" ||
      input.envelope.messageType !== "asset.content" ||
      input.envelope.vaultId !== input.vaultId
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Invalid Vault attachment envelope.",
      );
    }
    const { encryptedDigest, ciphertextBytes } = await digestVaultAssetEnvelope(
      input.envelope,
    );
    const existing = await this.listAttachmentTasks({
      vaultId: input.vaultId,
      roomId: input.roomId,
    });
    const duplicate = existing.find((task) => task.fileId === input.fileId);
    if (duplicate) {
      // The same opaque file ID must always resolve to its original
      // ciphertext. A different digest means a conflicting payload for the
      // same ID, which must fail closed instead of overwriting the task.
      if (
        duplicate.encryptedDigest !== encryptedDigest ||
        duplicate.ciphertextBytes !== ciphertextBytes
      ) {
        throw new VaultError(
          "VAULT_ASSET_CONFLICT",
          "Vault attachment file ID is bound to different ciphertext.",
        );
      }
      return duplicate;
    }
    const crypto = globalThis.crypto;
    if (!crypto?.randomUUID) {
      throw new VaultError(
        "VAULT_CRYPTO_UNAVAILABLE",
        "WebCrypto is unavailable.",
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    assertTimestamp(createdAt);
    const taskId = input.taskId ?? crypto.randomUUID();
    const record: VaultLocalAttachmentTaskRecord = {
      taskId,
      vaultId: input.vaultId,
      roomId: input.roomId,
      fileId: input.fileId,
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      protocolVersion: 1,
      status: "queued",
      envelope: input.envelope,
      encryptedDigest,
      ciphertextBytes,
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      lastAttemptAt: null,
      acknowledgedAt: null,
      errorCode: null,
    };
    assertVaultLocalAttachmentTaskRecord(record);
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_ATTACHMENT_TASK_STORE,
      "readwrite",
      (store) => store.put(record, record.taskId),
    );
    return record;
  }

  async listAttachmentTasks(input: {
    vaultId: string;
    roomId: string;
  }): Promise<readonly VaultLocalAttachmentTaskRecord[]> {
    const records = await runVaultLocalTransaction<unknown[]>(
      this.db,
      VAULT_LOCAL_ATTACHMENT_TASK_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    const scoped: VaultLocalAttachmentTaskRecord[] = [];
    for (const value of records ?? []) {
      assertVaultLocalAttachmentTaskRecord(value);
      if (value.vaultId === input.vaultId && value.roomId === input.roomId) {
        scoped.push(value);
      }
    }
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAttachmentTask(input: {
    vaultId: string;
    roomId: string;
    taskId: string;
  }): Promise<VaultLocalAttachmentTaskRecord | null> {
    const record =
      await runVaultLocalTransaction<VaultLocalAttachmentTaskRecord>(
        this.db,
        VAULT_LOCAL_ATTACHMENT_TASK_STORE,
        "readonly",
        (store) => store.get(input.taskId),
      );
    if (record === undefined) {
      return null;
    }
    assertVaultLocalAttachmentTaskRecord(record);
    if (record.vaultId !== input.vaultId || record.roomId !== input.roomId) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault local attachment scope mismatch.",
      );
    }
    return record;
  }

  async getAttachmentTaskByFileId(input: {
    vaultId: string;
    roomId: string;
    fileId: string;
  }): Promise<VaultLocalAttachmentTaskRecord | null> {
    const tasks = await this.listAttachmentTasks({
      vaultId: input.vaultId,
      roomId: input.roomId,
    });
    return tasks.find((task) => task.fileId === input.fileId) ?? null;
  }

  async updateAttachmentTask(
    record: VaultLocalAttachmentTaskRecord,
  ): Promise<void> {
    assertVaultLocalAttachmentTaskRecord(record);
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_ATTACHMENT_TASK_STORE,
      "readwrite",
      (store) => store.put(record, record.taskId),
    );
  }

  async deleteAttachmentTask(input: {
    vaultId: string;
    roomId: string;
    taskId: string;
  }): Promise<void> {
    const record = await this.getAttachmentTask(input);
    if (!record) {
      return;
    }
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_ATTACHMENT_TASK_STORE,
      "readwrite",
      (store) => store.delete(record.taskId),
    );
  }

  async getSnapshot<TSnapshot>(input: {
    vaultId: string;
    roomId: string;
    rootKey: string;
  }): Promise<VaultLocalSnapshotResult<TSnapshot> | null> {
    const key = createVaultLocalRecordKey(input.vaultId, input.roomId);
    const record = await runVaultLocalTransaction<VaultLocalSnapshotRecord>(
      this.db,
      VAULT_LOCAL_SNAPSHOT_STORE,
      "readonly",
      (store) => store.get(key),
    );
    if (record === undefined) {
      return null;
    }
    assertVaultLocalSnapshotRecord(record);
    if (record.vaultId !== input.vaultId || record.roomId !== input.roomId) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault local snapshot scope mismatch.",
      );
    }
    const snapshot = await decryptVaultLocalSnapshot<TSnapshot>({
      rootKey: input.rootKey,
      record,
    });
    if (record.schemaVersion === VAULT_LOCAL_SCHEMA_VERSION) {
      return {
        snapshot,
        generation: record.generation,
        updatedAt: record.updatedAt,
      };
    }

    // Schema 1 is the only supported migration. Re-encrypting binds the
    // current schema version into AAD before exposing the migrated snapshot.
    const migratedEnvelope = await encryptVaultLocalSnapshot({
      vaultId: record.vaultId,
      roomId: record.roomId,
      rootKey: input.rootKey,
      generation: record.generation,
      snapshot,
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
    });
    const migratedRecord: VaultLocalSnapshotRecord = {
      ...record,
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      envelope: migratedEnvelope,
    };
    await runVaultLocalTransaction(
      this.db,
      VAULT_LOCAL_SNAPSHOT_STORE,
      "readwrite",
      (store) => store.put(migratedRecord),
    );
    return {
      snapshot,
      generation: record.generation,
      updatedAt: record.updatedAt,
    };
  }
}
