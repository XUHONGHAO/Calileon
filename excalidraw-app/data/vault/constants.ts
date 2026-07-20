export const VAULT_PROTOCOL_VERSION = 1 as const;
export const VAULT_DEPLOYMENT_VERSION = "p4a-f4-v1" as const;
export const VAULT_SCHEMA_VERSION = 1 as const;
export const VAULT_ROOM_SERVER_VERSION = 1 as const;
export const VAULT_URL_MARKER = "vault" as const;
export const VAULT_URL_VERSION = "1" as const;

export const VAULT_SECRET_BYTES = 32;
export const VAULT_BASE64URL_SECRET_LENGTH = 43;
export const VAULT_IV_BYTES = 12;

export const VAULT_AAD_DOMAIN = "excalidraw-vault-envelope" as const;
export const VAULT_KEY_DERIVATION_DOMAIN = "excalidraw-vault-key" as const;
export const VAULT_CAPABILITY_HASH_DOMAIN =
  "excalidraw-vault-capability" as const;

export const VAULT_INITIAL_SNAPSHOT_GENERATION = 0;
export const VAULT_FIRST_SNAPSHOT_GENERATION = 1;
export const VAULT_FIRST_MESSAGE_SEQUENCE = 1;
export const VAULT_SOFT_DELETE_DAYS = 7;
