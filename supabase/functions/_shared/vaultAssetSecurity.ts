/* eslint-disable */

export const VAULT_ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const VAULT_ASSET_DOWNLOAD_TTL_SECONDS = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const VAULT_ASSET_ERROR_CODES = [
  "VAULT_PROTOCOL_UNSUPPORTED",
  "VAULT_CAPABILITY_MISSING",
  "VAULT_CAPABILITY_INVALID",
  "VAULT_CAPABILITY_FORBIDDEN",
  "VAULT_CAPABILITY_EXPIRED",
  "VAULT_CAPABILITY_REVOKED",
  "VAULT_NOT_FOUND",
  "VAULT_NOT_ACTIVE",
  "VAULT_ENVELOPE_INVALID",
  "VAULT_MESSAGE_TYPE_UNSUPPORTED",
  "VAULT_ASSET_CONFLICT",
  "VAULT_PERSISTENCE_UNAVAILABLE",
  "VAULT_RATE_LIMITED",
  "VAULT_PAYLOAD_TOO_LARGE",
  "VAULT_INTERNAL",
] as const;

export type VaultAssetErrorCode = typeof VAULT_ASSET_ERROR_CODES[number];
export type VaultAssetAccessAction =
  | "create-upload"
  | "complete-upload"
  | "create-download";

interface VaultAssetAccessBaseRequest {
  action: VaultAssetAccessAction;
  vaultId: string;
  invitationCapability: string;
  fileId: string;
}

export interface VaultAssetCreateUploadRequest
  extends VaultAssetAccessBaseRequest {
  action: "create-upload";
  encryptedDigest: string;
  ciphertextBytes: number;
}

export interface VaultAssetCompleteUploadRequest
  extends VaultAssetAccessBaseRequest {
  action: "complete-upload";
}

export interface VaultAssetCreateDownloadRequest
  extends VaultAssetAccessBaseRequest {
  action: "create-download";
}

export type VaultAssetAccessRequest =
  | VaultAssetCreateUploadRequest
  | VaultAssetCompleteUploadRequest
  | VaultAssetCreateDownloadRequest;

export class VaultAssetSecurityError extends Error {
  readonly code: VaultAssetErrorCode;

  constructor(code: VaultAssetErrorCode) {
    super(code);
    this.name = "VaultAssetSecurityError";
    this.code = code;
  }
}

const fail = (code: VaultAssetErrorCode): never => {
  throw new VaultAssetSecurityError(code);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (!BASE64URL_RE.test(value)) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return fail("VAULT_ENVELOPE_INVALID");
  }
};

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const isCanonicalBase64Url = (value: unknown, byteLength?: number) => {
  if (typeof value !== "string" || !BASE64URL_RE.test(value)) {
    return false;
  }
  try {
    const bytes = decodeBase64Url(value);
    return (
      (byteLength === undefined || bytes.byteLength === byteLength) &&
      encodeBase64Url(bytes) === value
    );
  } catch {
    return false;
  }
};

const requireSafeBytes = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  if (value > VAULT_ASSET_MAX_BYTES) {
    fail("VAULT_PAYLOAD_TOO_LARGE");
  }
  return value;
};

export const getVaultAssetStoragePath = (vaultId: string, fileId: string) =>
  `vault/${vaultId.toLowerCase()}/${fileId}`;

export const assertExactVaultAssetStoragePath = (
  value: unknown,
  vaultId: string,
  fileId: string,
) => {
  const expected = getVaultAssetStoragePath(vaultId, fileId);
  if (value !== expected) {
    fail("VAULT_INTERNAL");
  }
  return expected;
};

export const parseVaultAssetAccessRequest = (
  value: unknown,
): VaultAssetAccessRequest => {
  if (!isRecord(value) || typeof value.action !== "string") {
    fail("VAULT_ENVELOPE_INVALID");
  }
  if (!("invitationCapability" in value)) {
    fail("VAULT_CAPABILITY_MISSING");
  }
  const expectedKeys =
    value.action === "create-upload"
      ? [
          "action",
          "vaultId",
          "invitationCapability",
          "fileId",
          "encryptedDigest",
          "ciphertextBytes",
        ]
      : value.action === "complete-upload" || value.action === "create-download"
      ? ["action", "vaultId", "invitationCapability", "fileId"]
      : [];
  if (!expectedKeys.length || !hasExactKeys(value, expectedKeys)) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  if (typeof value.vaultId !== "string" || !UUID_RE.test(value.vaultId)) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  if (
    typeof value.invitationCapability !== "string" ||
    value.invitationCapability.length !== 43 ||
    !isCanonicalBase64Url(value.invitationCapability, 32)
  ) {
    fail("VAULT_CAPABILITY_INVALID");
  }
  if (typeof value.fileId !== "string" || !FILE_ID_RE.test(value.fileId)) {
    fail("VAULT_ENVELOPE_INVALID");
  }

  const base = {
    action: value.action,
    vaultId: value.vaultId.toLowerCase(),
    invitationCapability: value.invitationCapability,
    fileId: value.fileId,
  } as const;
  if (value.action === "create-upload") {
    if (!isCanonicalBase64Url(value.encryptedDigest, 32)) {
      fail("VAULT_ENVELOPE_INVALID");
    }
    return {
      ...base,
      action: "create-upload",
      encryptedDigest: value.encryptedDigest as string,
      ciphertextBytes: requireSafeBytes(value.ciphertextBytes),
    };
  }
  return {
    ...base,
    action: value.action as "complete-upload" | "create-download",
  };
};

export const sha256Base64Url = async (bytes: Uint8Array) =>
  encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

export const assertVaultAssetEnvelopeBytes = (
  bytes: Uint8Array,
  vaultId: string,
) => {
  requireSafeBytes(bytes.byteLength);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("VAULT_ENVELOPE_INVALID");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "vaultId",
      "purpose",
      "messageType",
      "messageId",
      "iv",
      "ciphertext",
    ])
  ) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  if (value.version !== 1) {
    fail("VAULT_PROTOCOL_UNSUPPORTED");
  }
  if (value.messageType !== "asset.content") {
    fail("VAULT_MESSAGE_TYPE_UNSUPPORTED");
  }
  if (
    value.vaultId !== vaultId.toLowerCase() ||
    value.purpose !== "asset" ||
    typeof value.messageId !== "string" ||
    !UUID_V4_RE.test(value.messageId) ||
    !isCanonicalBase64Url(value.iv, 12) ||
    !isCanonicalBase64Url(value.ciphertext)
  ) {
    fail("VAULT_ENVELOPE_INVALID");
  }

  const canonicalBytes = new TextEncoder().encode(
    JSON.stringify({
      version: value.version,
      vaultId: value.vaultId,
      purpose: value.purpose,
      messageType: value.messageType,
      messageId: value.messageId,
      iv: value.iv,
      ciphertext: value.ciphertext,
    }),
  );
  let mismatch = canonicalBytes.byteLength ^ bytes.byteLength;
  const comparisonLength = Math.max(
    canonicalBytes.byteLength,
    bytes.byteLength,
  );
  for (let index = 0; index < comparisonLength; index++) {
    mismatch |= (canonicalBytes[index] ?? 0) ^ (bytes[index] ?? 0);
  }
  if (mismatch !== 0) {
    fail("VAULT_ENVELOPE_INVALID");
  }
  return value;
};

const requireRpcRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    fail("VAULT_INTERNAL");
  }
  return value;
};

export const assertVaultCapabilityResolution = (
  value: unknown,
  vaultId: string,
  requiredRole?: "editor",
) => {
  const row = requireRpcRecord(value, [
    "vaultId",
    "invitationId",
    "role",
    "authorizationVersion",
    "activeRoomId",
    "snapshotGeneration",
    "expiresAt",
  ]);
  if (
    row.vaultId !== vaultId ||
    typeof row.invitationId !== "string" ||
    !UUID_RE.test(row.invitationId) ||
    (row.role !== "viewer" && row.role !== "editor") ||
    typeof row.authorizationVersion !== "number" ||
    !Number.isSafeInteger(row.authorizationVersion) ||
    row.authorizationVersion < 1 ||
    typeof row.activeRoomId !== "string" ||
    !FILE_ID_RE.test(row.activeRoomId) ||
    typeof row.snapshotGeneration !== "number" ||
    !Number.isSafeInteger(row.snapshotGeneration) ||
    row.snapshotGeneration < 0 ||
    (row.expiresAt !== null &&
      (typeof row.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(row.expiresAt))))
  ) {
    fail("VAULT_INTERNAL");
  }
  if (requiredRole === "editor" && row.role !== "editor") {
    fail("VAULT_CAPABILITY_FORBIDDEN");
  }
  return row;
};

export const assertVaultAssetRegistration = (
  value: unknown,
  vaultId: string,
  fileId: string,
) => {
  const row = requireRpcRecord(value, [
    "vaultId",
    "fileId",
    "storagePath",
    "state",
  ]);
  if (
    row.vaultId !== vaultId ||
    row.fileId !== fileId ||
    (row.state !== "pending" && row.state !== "ready")
  ) {
    fail("VAULT_INTERNAL");
  }
  const storagePath = assertExactVaultAssetStoragePath(
    row.storagePath,
    vaultId,
    fileId,
  );
  return { storagePath, state: row.state as "pending" | "ready" };
};

export const assertVaultAssetResolution = (
  value: unknown,
  vaultId: string,
  fileId: string,
) => {
  const row = requireRpcRecord(value, [
    "vaultId",
    "fileId",
    "storagePath",
    "encryptedDigest",
    "ciphertextBytes",
  ]);
  if (
    row.vaultId !== vaultId ||
    row.fileId !== fileId ||
    !isCanonicalBase64Url(row.encryptedDigest, 32)
  ) {
    fail("VAULT_INTERNAL");
  }
  return {
    storagePath: assertExactVaultAssetStoragePath(
      row.storagePath,
      vaultId,
      fileId,
    ),
    encryptedDigest: row.encryptedDigest as string,
    ciphertextBytes: requireSafeBytes(row.ciphertextBytes),
  };
};

export const toStableVaultAssetErrorCode = (
  error: unknown,
): VaultAssetErrorCode => {
  if (error instanceof VaultAssetSecurityError) {
    return error.code;
  }
  const candidate =
    isRecord(error) && typeof error.message === "string" ? error : null;
  if (
    candidate?.code === "P0001" &&
    (VAULT_ASSET_ERROR_CODES as readonly string[]).includes(candidate.message)
  ) {
    return candidate.message as VaultAssetErrorCode;
  }
  const status = Number(
    isRecord(error) ? error.statusCode ?? error.status : undefined,
  );
  if (status === 401 || status === 403) {
    return "VAULT_CAPABILITY_FORBIDDEN";
  }
  if (status === 413) {
    return "VAULT_PAYLOAD_TOO_LARGE";
  }
  if (status === 429) {
    return "VAULT_RATE_LIMITED";
  }
  return "VAULT_INTERNAL";
};

export const getVaultAssetErrorStatus = (code: VaultAssetErrorCode) => {
  if (code === "VAULT_NOT_FOUND") return 404;
  if (code === "VAULT_ASSET_CONFLICT") return 409;
  if (code === "VAULT_PAYLOAD_TOO_LARGE") return 413;
  if (code === "VAULT_RATE_LIMITED") return 429;
  if (
    code === "VAULT_CAPABILITY_FORBIDDEN" ||
    code === "VAULT_CAPABILITY_EXPIRED" ||
    code === "VAULT_CAPABILITY_REVOKED" ||
    code === "VAULT_NOT_ACTIVE"
  ) {
    return 403;
  }
  if (
    code === "VAULT_PROTOCOL_UNSUPPORTED" ||
    code === "VAULT_CAPABILITY_MISSING" ||
    code === "VAULT_CAPABILITY_INVALID" ||
    code === "VAULT_ENVELOPE_INVALID" ||
    code === "VAULT_MESSAGE_TYPE_UNSUPPORTED"
  ) {
    return 400;
  }
  if (code === "VAULT_PERSISTENCE_UNAVAILABLE") return 503;
  return 500;
};
