import { isVaultErrorCode } from "./errors";

import type { VaultErrorCode } from "./errors";

export interface VaultLogMetadata {
  operation: string;
  vaultId?: string;
  messageId?: string;
  sequence?: number;
  generation?: number;
  ciphertextBytes?: number;
  status?: string;
}

export interface VaultLogRecord extends VaultLogMetadata {
  code: VaultErrorCode;
  recoverable: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LABEL_RE = /^[a-z0-9_.:-]{1,96}$/;

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const toVaultLogRecord = (
  error: unknown,
  metadata: VaultLogMetadata,
): VaultLogRecord => {
  const candidate = error as {
    code?: unknown;
    recoverable?: unknown;
  } | null;
  const record: VaultLogRecord = {
    operation: SAFE_LABEL_RE.test(metadata.operation)
      ? metadata.operation
      : "vault.unknown",
    code: isVaultErrorCode(candidate?.code) ? candidate.code : "VAULT_INTERNAL",
    recoverable:
      typeof candidate?.recoverable === "boolean"
        ? candidate.recoverable
        : false,
  };
  if (metadata.vaultId && UUID_RE.test(metadata.vaultId)) {
    record.vaultId = metadata.vaultId.toLowerCase();
  }
  if (metadata.messageId && UUID_RE.test(metadata.messageId)) {
    record.messageId = metadata.messageId.toLowerCase();
  }
  if (isSafeInteger(metadata.sequence)) {
    record.sequence = metadata.sequence;
  }
  if (isSafeInteger(metadata.generation)) {
    record.generation = metadata.generation;
  }
  if (isSafeInteger(metadata.ciphertextBytes)) {
    record.ciphertextBytes = metadata.ciphertextBytes;
  }
  if (metadata.status && SAFE_LABEL_RE.test(metadata.status)) {
    record.status = metadata.status;
  }
  return record;
};

export const reportVaultError = (
  error: unknown,
  metadata: VaultLogMetadata,
) => {
  console.error("Vault operation failed", toVaultLogRecord(error, metadata));
};
