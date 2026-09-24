import {
  VAULT_KEY_DERIVATION_DOMAIN,
  VAULT_PROTOCOL_VERSION,
  VAULT_SECRET_BYTES,
} from "../constants";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  isCanonicalBase64Url,
} from "../encoding";
import { VaultError } from "../errors";
import { createVaultMessageId } from "../protocol";

import {
  VAULT_LOCAL_ENVELOPE_VERSION,
  VAULT_LOCAL_SCHEMA_VERSION,
  assertVaultLocalScope,
  type VaultLocalSnapshotEnvelope,
} from "./domain";

import type { VaultLocalSnapshotRecord } from "./domain";

const LOCAL_KEY_DOMAIN = "excalidraw-vault-local-store" as const;
const LOCAL_PURPOSE = "local.snapshot" as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireCrypto = (): Crypto => {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  return globalThis.crypto;
};

const validateRootKey = (rootKey: string): Uint8Array<ArrayBuffer> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(rootKey);
  } catch {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault root key.");
  }
  if (
    rootKey.length !== 43 ||
    bytes.byteLength !== VAULT_SECRET_BYTES ||
    !isCanonicalBase64Url(rootKey, VAULT_SECRET_BYTES)
  ) {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault root key.");
  }
  return bytes;
};

const deriveLocalStorageKey = async (
  rootKey: string,
  vaultId: string,
  roomId: string,
): Promise<CryptoKey> => {
  const crypto = requireCrypto();
  assertVaultLocalScope(vaultId, roomId);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    validateRootKey(rootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = new TextEncoder().encode(
    `${VAULT_KEY_DERIVATION_DOMAIN}\0${VAULT_PROTOCOL_VERSION}\0${vaultId.toLowerCase()}\0${LOCAL_KEY_DOMAIN}`,
  );
  const info = new TextEncoder().encode(`${LOCAL_KEY_DOMAIN}\0${roomId}`);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const encodeLocalSnapshotAad = (
  schemaVersion: number,
  vaultId: string,
  roomId: string,
  messageId: string,
  generation: number,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      LOCAL_KEY_DOMAIN,
      VAULT_LOCAL_ENVELOPE_VERSION,
      schemaVersion,
      VAULT_PROTOCOL_VERSION,
      vaultId,
      roomId,
      LOCAL_PURPOSE,
      messageId,
      generation,
    ]),
  );

const assertSchemaVersion = (schemaVersion: number) => {
  if (schemaVersion !== 1 && schemaVersion !== VAULT_LOCAL_SCHEMA_VERSION) {
    throw new VaultError(
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "Unsupported Vault local snapshot schema.",
    );
  }
};

export const encryptVaultLocalSnapshot = async <TSnapshot>(input: {
  vaultId: string;
  roomId: string;
  rootKey: string;
  generation: number;
  snapshot: TSnapshot;
  schemaVersion?: number;
}): Promise<VaultLocalSnapshotEnvelope> => {
  const crypto = requireCrypto();
  assertVaultLocalScope(input.vaultId, input.roomId);
  assertSchemaVersion(input.schemaVersion ?? VAULT_LOCAL_SCHEMA_VERSION);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot generation.",
    );
  }
  const serialized = JSON.stringify(input.snapshot);
  if (serialized === undefined) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local snapshot is not JSON serializable.",
    );
  }
  const messageId = createVaultMessageId();
  const schemaVersion = input.schemaVersion ?? VAULT_LOCAL_SCHEMA_VERSION;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveLocalStorageKey(
    input.rootKey,
    input.vaultId,
    input.roomId,
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeLocalSnapshotAad(
        schemaVersion,
        input.vaultId,
        input.roomId,
        messageId,
        input.generation,
      ),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(serialized),
  );
  return {
    version: VAULT_LOCAL_ENVELOPE_VERSION,
    schemaVersion,
    vaultId: input.vaultId,
    roomId: input.roomId,
    purpose: LOCAL_PURPOSE,
    messageId,
    generation: input.generation,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
};

export const decryptVaultLocalSnapshot = async <TSnapshot>(input: {
  rootKey: string;
  record: VaultLocalSnapshotRecord;
}): Promise<TSnapshot> => {
  const crypto = requireCrypto();
  assertSchemaVersion(input.record.schemaVersion);
  assertVaultLocalScope(input.record.vaultId, input.record.roomId);
  const envelope = input.record.envelope;
  if (
    !UUID_RE.test(envelope.messageId) ||
    !isCanonicalBase64Url(envelope.iv, 12) ||
    !isCanonicalBase64Url(envelope.ciphertext)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault local snapshot ciphertext.",
    );
  }
  const key = await deriveLocalStorageKey(
    input.rootKey,
    input.record.vaultId,
    input.record.roomId,
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(envelope.iv),
        additionalData: encodeLocalSnapshotAad(
          envelope.schemaVersion,
          envelope.vaultId,
          envelope.roomId,
          envelope.messageId,
          envelope.generation,
        ),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(envelope.ciphertext),
    );
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault local snapshot authentication failed.",
    );
  }
  try {
    return JSON.parse(
      new TextDecoder().decode(new Uint8Array(plaintext)),
    ) as TSnapshot;
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault local snapshot plaintext is invalid.",
    );
  }
};

export const digestVaultLocalCiphertext = async (
  ciphertext: string,
): Promise<string> => {
  const crypto = requireCrypto();
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(ciphertext);
  } catch {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault ciphertext digest input.",
    );
  }
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  );
};
