import { VAULT_PROTOCOL_VERSION } from "../constants";
import { isVaultErrorCode, VaultError } from "../errors";
import { assertVaultEncryptedEnvelopeV1 } from "../protocol";

import type {
  VaultAssetEncryptedEnvelopeV1,
  VaultEncryptedEnvelopeV1,
} from "../types";
import type { VaultErrorCode } from "../errors";

export const VAULT_LOCAL_DB_NAME = "excalidraw-vault-local" as const;
export const VAULT_LOCAL_DB_VERSION = 2 as const;
export const VAULT_LOCAL_SCHEMA_VERSION = 2 as const;
export const VAULT_LOCAL_ENVELOPE_VERSION = 1 as const;

export const VAULT_LOCAL_SNAPSHOT_STORE = "snapshots" as const;
export const VAULT_LOCAL_ATTACHMENT_TASK_STORE = "attachmentTasks" as const;
export const VAULT_LOCAL_OUTBOX_STORE = "outbox" as const;
export const VAULT_LOCAL_META_STORE = "meta" as const;

export const VAULT_LOCAL_STORE_NAMES = [
  VAULT_LOCAL_SNAPSHOT_STORE,
  VAULT_LOCAL_ATTACHMENT_TASK_STORE,
  VAULT_LOCAL_OUTBOX_STORE,
  VAULT_LOCAL_META_STORE,
] as const;

export type VaultLocalStoreName = typeof VAULT_LOCAL_STORE_NAMES[number];

export type VaultLocalSnapshotEnvelope = {
  version: typeof VAULT_LOCAL_ENVELOPE_VERSION;
  schemaVersion: number;
  vaultId: string;
  roomId: string;
  purpose: "local.snapshot";
  messageId: string;
  generation: number;
  iv: string;
  ciphertext: string;
};

export interface VaultLocalSnapshotRecord {
  key: string;
  schemaVersion: number;
  protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  vaultId: string;
  roomId: string;
  generation: number;
  updatedAt: number;
  envelope: VaultLocalSnapshotEnvelope;
}

export const VAULT_LOCAL_ATTACHMENT_TASK_STATUSES = [
  "queued",
  "uploading",
  "retry",
  "complete",
  "failed",
] as const;

export type VaultLocalAttachmentTaskStatus =
  typeof VAULT_LOCAL_ATTACHMENT_TASK_STATUSES[number];

/**
 * B3 record contract. The stable taskId/fileId survive every retry, and the
 * already-encrypted asset envelope is persisted so an interrupted upload can be
 * resumed after refresh or crash without touching the original file again.
 */
export interface VaultLocalAttachmentTaskRecord {
  taskId: string;
  vaultId: string;
  roomId: string;
  fileId: string;
  schemaVersion: typeof VAULT_LOCAL_SCHEMA_VERSION;
  protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  status: VaultLocalAttachmentTaskStatus;
  envelope: VaultAssetEncryptedEnvelopeV1;
  encryptedDigest: string;
  ciphertextBytes: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  acknowledgedAt: number | null;
  errorCode: VaultErrorCode | null;
}

export type VaultLocalOutboxKind =
  | "realtime.content"
  | "realtime.presence"
  | "snapshot.commit";

export type VaultLocalOutboxStatus =
  | "pending"
  | "sending"
  | "confirmed"
  | "conflict"
  | "failed";

export type VaultLocalOutboxConflictReason =
  | "generation"
  | "update-id"
  | "remote-unavailable";

/** B2 record contract. updateId is stable across retries. */
export interface VaultLocalOutboxRecord {
  updateId: string;
  vaultId: string;
  roomId: string;
  kind: VaultLocalOutboxKind;
  schemaVersion: typeof VAULT_LOCAL_SCHEMA_VERSION;
  protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  envelope: VaultEncryptedEnvelopeV1;
  expectedGeneration: number;
  status: VaultLocalOutboxStatus;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  acknowledgedAt: number | null;
  errorCode: VaultErrorCode | null;
  ciphertextBytes: number;
  ciphertextDigest: string;
  remoteEnvelope: VaultEncryptedEnvelopeV1 | null;
  remoteGeneration: number | null;
  conflictReason: VaultLocalOutboxConflictReason | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SNAPSHOT_KEYS = [
  "key",
  "schemaVersion",
  "protocolVersion",
  "vaultId",
  "roomId",
  "generation",
  "updatedAt",
  "envelope",
] as const;

const ENVELOPE_KEYS = [
  "version",
  "schemaVersion",
  "vaultId",
  "roomId",
  "purpose",
  "messageId",
  "generation",
  "iv",
  "ciphertext",
] as const;

const ATTACHMENT_TASK_KEYS = [
  "taskId",
  "vaultId",
  "roomId",
  "fileId",
  "schemaVersion",
  "protocolVersion",
  "status",
  "envelope",
  "encryptedDigest",
  "ciphertextBytes",
  "attempts",
  "createdAt",
  "updatedAt",
  "lastAttemptAt",
  "acknowledgedAt",
  "errorCode",
] as const;

const OUTBOX_KEYS = [
  "updateId",
  "vaultId",
  "roomId",
  "kind",
  "schemaVersion",
  "protocolVersion",
  "envelope",
  "expectedGeneration",
  "status",
  "attempts",
  "createdAt",
  "lastAttemptAt",
  "acknowledgedAt",
  "errorCode",
  "ciphertextBytes",
  "ciphertextDigest",
  "remoteEnvelope",
  "remoteGeneration",
  "conflictReason",
] as const;

const hasExactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
};

export const assertVaultLocalScope = (vaultId: string, roomId: string) => {
  if (
    !UUID_RE.test(vaultId) ||
    typeof roomId !== "string" ||
    roomId.length === 0 ||
    roomId.length > 256 ||
    roomId.includes("\0")
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local scope.",
    );
  }
};

export const createVaultLocalRecordKey = (vaultId: string, roomId: string) => {
  assertVaultLocalScope(vaultId, roomId);
  return `${vaultId}\0${roomId}`;
};

export function assertVaultLocalSnapshotRecord(
  value: unknown,
): asserts value is VaultLocalSnapshotRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot record.",
    );
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, SNAPSHOT_KEYS)) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local snapshot schema.",
    );
  }
  if (
    record.schemaVersion !== 1 &&
    record.schemaVersion !== VAULT_LOCAL_SCHEMA_VERSION
  ) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local snapshot schema.",
    );
  }
  if (
    record.protocolVersion !== VAULT_PROTOCOL_VERSION ||
    typeof record.vaultId !== "string" ||
    typeof record.roomId !== "string" ||
    typeof record.key !== "string" ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 0 ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot record.",
    );
  }
  assertVaultLocalScope(record.vaultId, record.roomId);
  if (record.key !== createVaultLocalRecordKey(record.vaultId, record.roomId)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local snapshot scope mismatch.",
    );
  }
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot envelope.",
    );
  }
  const envelopeValue = envelope as Record<string, unknown>;
  if (!hasExactKeys(envelopeValue, ENVELOPE_KEYS)) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local envelope schema.",
    );
  }
  if (
    envelopeValue.version !== VAULT_LOCAL_ENVELOPE_VERSION ||
    envelopeValue.schemaVersion !== record.schemaVersion ||
    envelopeValue.vaultId !== record.vaultId ||
    envelopeValue.roomId !== record.roomId ||
    envelopeValue.purpose !== "local.snapshot" ||
    typeof envelopeValue.messageId !== "string" ||
    typeof envelopeValue.generation !== "number" ||
    envelopeValue.generation !== record.generation ||
    typeof envelopeValue.iv !== "string" ||
    typeof envelopeValue.ciphertext !== "string"
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot binding.",
    );
  }
}

const VAULT_FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;

const isVaultLocalAttachmentTaskStatus = (
  value: unknown,
): value is VaultLocalAttachmentTaskStatus =>
  typeof value === "string" &&
  (VAULT_LOCAL_ATTACHMENT_TASK_STATUSES as readonly string[]).includes(value);

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function assertVaultLocalAttachmentTaskRecord(
  value: unknown,
): asserts value is VaultLocalAttachmentTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local attachment record.",
    );
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ATTACHMENT_TASK_KEYS)) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local attachment schema.",
    );
  }
  if (
    typeof record.taskId !== "string" ||
    !UUID_RE.test(record.taskId) ||
    typeof record.vaultId !== "string" ||
    typeof record.roomId !== "string" ||
    typeof record.fileId !== "string" ||
    !VAULT_FILE_ID_RE.test(record.fileId) ||
    record.schemaVersion !== VAULT_LOCAL_SCHEMA_VERSION ||
    record.protocolVersion !== VAULT_PROTOCOL_VERSION ||
    !isVaultLocalAttachmentTaskStatus(record.status) ||
    typeof record.encryptedDigest !== "string" ||
    !BASE64URL_DIGEST_RE.test(record.encryptedDigest) ||
    typeof record.ciphertextBytes !== "number" ||
    !Number.isSafeInteger(record.ciphertextBytes) ||
    record.ciphertextBytes <= 0 ||
    typeof record.attempts !== "number" ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0 ||
    !isFiniteTimestamp(record.createdAt) ||
    !isFiniteTimestamp(record.updatedAt) ||
    (record.lastAttemptAt !== null &&
      !isFiniteTimestamp(record.lastAttemptAt)) ||
    (record.acknowledgedAt !== null &&
      !isFiniteTimestamp(record.acknowledgedAt)) ||
    (record.errorCode !== null && !isVaultErrorCode(record.errorCode))
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local attachment metadata.",
    );
  }
  assertVaultLocalScope(record.vaultId, record.roomId);
  if ((record.status === "complete") !== (record.acknowledgedAt !== null)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local attachment acknowledgement mismatch.",
    );
  }
  if (record.status === "failed" && record.errorCode === null) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Failed Vault local attachment is missing an error code.",
    );
  }
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local attachment envelope.",
    );
  }
  assertVaultEncryptedEnvelopeV1(envelope);
  if (
    envelope.purpose !== "asset" ||
    envelope.messageType !== "asset.content" ||
    envelope.vaultId !== record.vaultId
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local attachment envelope binding mismatch.",
    );
  }
}

export function assertVaultLocalOutboxRecord(
  value: unknown,
): asserts value is VaultLocalOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local outbox record.",
    );
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, OUTBOX_KEYS)) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local outbox schema.",
    );
  }
  if (
    typeof record.updateId !== "string" ||
    !UUID_RE.test(record.updateId) ||
    typeof record.vaultId !== "string" ||
    typeof record.roomId !== "string" ||
    record.schemaVersion !== VAULT_LOCAL_SCHEMA_VERSION ||
    record.protocolVersion !== VAULT_PROTOCOL_VERSION ||
    (record.kind !== "snapshot.commit" &&
      record.kind !== "realtime.content" &&
      record.kind !== "realtime.presence") ||
    typeof record.expectedGeneration !== "number" ||
    !Number.isSafeInteger(record.expectedGeneration) ||
    record.expectedGeneration < 0 ||
    (record.status !== "pending" &&
      record.status !== "sending" &&
      record.status !== "confirmed" &&
      record.status !== "conflict" &&
      record.status !== "failed") ||
    typeof record.attempts !== "number" ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0 ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    (record.lastAttemptAt !== null &&
      (typeof record.lastAttemptAt !== "number" ||
        !Number.isFinite(record.lastAttemptAt))) ||
    (record.acknowledgedAt !== null &&
      (typeof record.acknowledgedAt !== "number" ||
        !Number.isFinite(record.acknowledgedAt))) ||
    (record.errorCode !== null && !isVaultErrorCode(record.errorCode)) ||
    typeof record.ciphertextBytes !== "number" ||
    !Number.isSafeInteger(record.ciphertextBytes) ||
    record.ciphertextBytes <= 0 ||
    typeof record.ciphertextDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.ciphertextDigest)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local outbox metadata.",
    );
  }
  assertVaultLocalScope(record.vaultId, record.roomId);
  if (record.status === "confirmed" && record.acknowledgedAt === null) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Confirmed Vault outbox record is missing acknowledgement time.",
    );
  }
  if (record.status !== "confirmed" && record.acknowledgedAt !== null) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Unconfirmed Vault outbox record has an acknowledgement time.",
    );
  }
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local outbox envelope.",
    );
  }
  assertVaultEncryptedEnvelopeV1(envelope);
  const isSnapshotCommit = record.kind === "snapshot.commit";
  const envelopeBindingValid = isSnapshotCommit
    ? envelope.purpose === "snapshot" &&
      envelope.messageType === "snapshot.scene" &&
      envelope.generation === record.expectedGeneration + 1
    : envelope.purpose === "realtime" &&
      (envelope.messageType === "realtime.content" ||
        envelope.messageType === "realtime.presence");
  if (
    envelope.vaultId !== record.vaultId ||
    envelope.messageId !== record.updateId ||
    !envelopeBindingValid
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local outbox envelope binding mismatch.",
    );
  }
  if (record.remoteEnvelope !== null) {
    assertVaultEncryptedEnvelopeV1(record.remoteEnvelope);
    if (
      !record.remoteEnvelope ||
      record.remoteEnvelope.vaultId !== record.vaultId ||
      record.remoteEnvelope.purpose !== "snapshot" ||
      record.remoteEnvelope.messageType !== "snapshot.scene" ||
      record.remoteGeneration !== record.remoteEnvelope.generation
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Invalid Vault remote conflict envelope.",
      );
    }
  } else if (
    record.remoteGeneration !== null ||
    record.conflictReason !== null
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault outbox conflict metadata is incomplete.",
    );
  }
}
