import { base64UrlToBytes, isCanonicalBase64Url } from "../../vault/encoding";
import { VaultError } from "../../vault/errors";
import { assertVaultEncryptedEnvelopeV1 } from "../../vault/protocol";

import type {
  VaultAssetRegistrationResult,
  VaultSnapshotCasResult,
} from "../../vault/backendContract";
import type {
  VaultAssetResolution,
  VaultSnapshotRecord,
} from "../../vault/persistence";
import type {
  VaultOwnerActivateResult,
  VaultOwnerCreateResult,
  VaultOwnerInvitationResult,
  VaultOwnerInvitationRevocation,
  VaultOwnerVaultDeletion,
  VaultOwnerVaultRevocation,
} from "../../vault/owner";
import type { VaultCapabilityResolution, VaultRole } from "../../vault/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => actualKeys.includes(key))
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return value;
};

const requireString = (
  value: unknown,
  predicate: (value: string) => boolean = () => true,
): string => {
  if (typeof value !== "string" || !predicate(value)) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return value;
};

const requireSafeInteger = (value: unknown, minimum = 0): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return value;
};

const requireTimestamp = (value: unknown): number => {
  if (typeof value !== "string") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return timestamp;
};

const requireRole = (value: unknown): VaultRole => {
  if (value !== "viewer" && value !== "editor") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return value;
};

export const mapVaultCapabilityResolution = (
  value: unknown,
): VaultCapabilityResolution => {
  const row = assertExactKeys(value, [
    "vaultId",
    "invitationId",
    "role",
    "authorizationVersion",
    "activeRoomId",
    "snapshotGeneration",
    "expiresAt",
  ]);
  const expiresAt = row.expiresAt;
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    invitationId: requireString(row.invitationId, (candidate) =>
      UUID_RE.test(candidate),
    ),
    role: requireRole(row.role),
    authorizationVersion: requireSafeInteger(row.authorizationVersion, 1),
    activeRoomId: requireString(row.activeRoomId, (candidate) =>
      ROOM_ID_RE.test(candidate),
    ),
    snapshotGeneration: requireSafeInteger(row.snapshotGeneration),
    expiresAt: expiresAt === null ? null : requireTimestamp(expiresAt),
  };
};

export const mapVaultSnapshotRecord = (value: unknown): VaultSnapshotRecord => {
  const row = assertExactKeys(value, [
    "vaultId",
    "generation",
    "encryptedEnvelope",
    "ciphertextBytes",
    "updatedAt",
  ]);
  const vaultId = requireString(row.vaultId, (candidate) =>
    UUID_RE.test(candidate),
  );
  const generation = requireSafeInteger(row.generation, 1);
  assertVaultEncryptedEnvelopeV1(row.encryptedEnvelope);
  if (
    row.encryptedEnvelope.purpose !== "snapshot" ||
    row.encryptedEnvelope.vaultId !== vaultId ||
    row.encryptedEnvelope.generation !== generation
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault snapshot.");
  }
  const ciphertextBytes = requireSafeInteger(row.ciphertextBytes, 1);
  if (
    base64UrlToBytes(row.encryptedEnvelope.ciphertext).byteLength !==
    ciphertextBytes
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault snapshot.");
  }
  return {
    vaultId,
    generation,
    encryptedEnvelope: row.encryptedEnvelope,
    ciphertextBytes,
    updatedAt: requireTimestamp(row.updatedAt),
  };
};

export const mapVaultSnapshotCasResult = (
  value: unknown,
): VaultSnapshotCasResult => {
  const row = assertExactKeys(value, ["vaultId", "generation", "updatedAt"]);
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    generation: requireSafeInteger(row.generation, 1),
    updatedAt: requireTimestamp(row.updatedAt),
  };
};

export const mapVaultAssetRegistrationResult = (
  value: unknown,
): VaultAssetRegistrationResult => {
  const row = assertExactKeys(value, [
    "vaultId",
    "fileId",
    "storagePath",
    "state",
  ]);
  const vaultId = requireString(row.vaultId, (candidate) =>
    UUID_RE.test(candidate),
  );
  const fileId = requireString(row.fileId, (candidate) =>
    FILE_ID_RE.test(candidate),
  );
  const storagePath = requireString(
    row.storagePath,
    (candidate) => candidate === `vault/${vaultId.toLowerCase()}/${fileId}`,
  );
  if (row.state !== "pending" && row.state !== "ready") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return { vaultId, fileId, storagePath, state: row.state };
};

export const mapVaultAssetResolution = (
  value: unknown,
): VaultAssetResolution => {
  const row = assertExactKeys(value, [
    "vaultId",
    "fileId",
    "storagePath",
    "encryptedDigest",
    "ciphertextBytes",
  ]);
  const vaultId = requireString(row.vaultId, (candidate) =>
    UUID_RE.test(candidate),
  );
  const fileId = requireString(row.fileId, (candidate) =>
    FILE_ID_RE.test(candidate),
  );
  return {
    vaultId,
    fileId,
    storagePath: requireString(
      row.storagePath,
      (candidate) => candidate === `vault/${vaultId.toLowerCase()}/${fileId}`,
    ),
    encryptedDigest: requireString(
      row.encryptedDigest,
      (candidate) =>
        candidate.length === 43 && isCanonicalBase64Url(candidate, 32),
    ),
    ciphertextBytes: requireSafeInteger(row.ciphertextBytes, 1),
  };
};

export const mapVaultOwnerCreateResult = (
  value: unknown,
): VaultOwnerCreateResult => {
  const row = assertExactKeys(value, [
    "vaultId",
    "state",
    "invitationId",
    "snapshotGeneration",
  ]);
  if (row.state !== "creating" || row.snapshotGeneration !== 0) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    state: row.state,
    invitationId: requireString(row.invitationId, (candidate) =>
      UUID_RE.test(candidate),
    ),
    snapshotGeneration: row.snapshotGeneration,
  };
};

export const mapVaultOwnerActivateResult = (
  value: unknown,
): VaultOwnerActivateResult => {
  const row = assertExactKeys(value, ["vaultId", "state", "activeRoomId"]);
  if (row.state !== "active") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    state: row.state,
    activeRoomId: requireString(row.activeRoomId, (candidate) =>
      ROOM_ID_RE.test(candidate),
    ),
  };
};

export const mapVaultOwnerInvitationResult = (
  value: unknown,
): VaultOwnerInvitationResult => {
  const row = assertExactKeys(value, [
    "invitationId",
    "vaultId",
    "role",
    "authorizationVersion",
    "expiresAt",
  ]);
  return {
    invitationId: requireString(row.invitationId, (candidate) =>
      UUID_RE.test(candidate),
    ),
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    role: requireRole(row.role),
    authorizationVersion: requireSafeInteger(row.authorizationVersion, 1),
    expiresAt: row.expiresAt === null ? null : requireTimestamp(row.expiresAt),
  };
};

export const mapVaultOwnerInvitationRevocation = (
  value: unknown,
): VaultOwnerInvitationRevocation => {
  const row = assertExactKeys(value, [
    "vaultId",
    "invitationId",
    "authorizationVersion",
    "reason",
  ]);
  if (row.reason !== "revoked") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    invitationId: requireString(row.invitationId, (candidate) =>
      UUID_RE.test(candidate),
    ),
    authorizationVersion: requireSafeInteger(row.authorizationVersion, 1),
    reason: row.reason,
  };
};

export const mapVaultOwnerVaultRevocation = (
  value: unknown,
): VaultOwnerVaultRevocation => {
  const row = assertExactKeys(value, ["vaultId", "reason"]);
  if (row.reason !== "vault-revoked") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    reason: row.reason,
  };
};

export const mapVaultOwnerVaultDeletion = (
  value: unknown,
): VaultOwnerVaultDeletion => {
  const row = assertExactKeys(value, ["vaultId", "reason", "deleteAfter"]);
  if (row.reason !== "vault-deleted") {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
  return {
    vaultId: requireString(row.vaultId, (candidate) => UUID_RE.test(candidate)),
    reason: row.reason,
    deleteAfter: requireTimestamp(row.deleteAfter),
  };
};
