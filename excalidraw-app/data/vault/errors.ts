export const VAULT_ERROR_CODES = [
  "VAULT_URL_INVALID",
  "VAULT_PROTOCOL_UNSUPPORTED",
  "VAULT_SECURE_CONTEXT_REQUIRED",
  "VAULT_CRYPTO_UNAVAILABLE",
  "VAULT_KEY_INVALID",
  "VAULT_CAPABILITY_MISSING",
  "VAULT_CAPABILITY_INVALID",
  "VAULT_CAPABILITY_FORBIDDEN",
  "VAULT_CAPABILITY_EXPIRED",
  "VAULT_CAPABILITY_REVOKED",
  "VAULT_ALREADY_EXISTS",
  "VAULT_NOT_FOUND",
  "VAULT_NOT_ACTIVE",
  "VAULT_ENVELOPE_INVALID",
  "VAULT_MESSAGE_TYPE_UNSUPPORTED",
  "VAULT_DECRYPT_FAILED",
  "VAULT_REPLAY_REJECTED",
  "VAULT_SEQUENCE_REJECTED",
  "VAULT_SNAPSHOT_CONFLICT",
  "VAULT_ASSET_CONFLICT",
  "VAULT_PERSISTENCE_UNAVAILABLE",
  "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
  "VAULT_PLAIN_FALLBACK_FORBIDDEN",
  "VAULT_EGRESS_DENIED",
  "VAULT_RATE_LIMITED",
  "VAULT_PAYLOAD_TOO_LARGE",
  "VAULT_INTERNAL",
] as const;

export type VaultErrorCode = typeof VAULT_ERROR_CODES[number];

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: VaultErrorCode,
    message: string,
    options?: { recoverable?: boolean },
  ) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
  }
}

export const isVaultErrorCode = (value: unknown): value is VaultErrorCode =>
  typeof value === "string" &&
  (VAULT_ERROR_CODES as readonly string[]).includes(value);
