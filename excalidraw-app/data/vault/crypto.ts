import {
  VAULT_BASE64URL_SECRET_LENGTH,
  VAULT_CAPABILITY_HASH_DOMAIN,
  VAULT_IV_BYTES,
  VAULT_KEY_DERIVATION_DOMAIN,
  VAULT_PROTOCOL_VERSION,
  VAULT_SECRET_BYTES,
} from "./constants";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  isCanonicalBase64Url,
} from "./encoding";
import { VaultError } from "./errors";
import {
  assertVaultEncryptedEnvelopeV1,
  assertVaultEnvelopeContextV1,
  encodeVaultEnvelopeAadV1,
} from "./protocol";

import type {
  VaultEncryptedEnvelopeV1,
  VaultEnvelopeContextV1,
  VaultPurpose,
} from "./types";

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

const validateSecret = (
  secret: string,
  code: "VAULT_KEY_INVALID" | "VAULT_CAPABILITY_INVALID",
): Uint8Array<ArrayBuffer> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(secret);
  } catch {
    throw new VaultError(code, "Invalid Vault secret.");
  }
  if (
    secret.length !== VAULT_BASE64URL_SECRET_LENGTH ||
    bytes.byteLength !== VAULT_SECRET_BYTES ||
    !isCanonicalBase64Url(secret, VAULT_SECRET_BYTES)
  ) {
    throw new VaultError(code, "Invalid Vault secret.");
  }
  return bytes;
};

export const generateVaultSecret = (): string => {
  const crypto = requireCrypto();
  return bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(VAULT_SECRET_BYTES)),
  );
};

export const generateVaultRootKey = generateVaultSecret;
export const generateVaultInvitationCapability = generateVaultSecret;

export const hashVaultInvitationCapability = async (
  vaultId: string,
  invitationCapability: string,
): Promise<string> => {
  const crypto = requireCrypto();
  if (!UUID_RE.test(vaultId)) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault ID.");
  }
  validateSecret(invitationCapability, "VAULT_CAPABILITY_INVALID");
  const input = new TextEncoder().encode(
    `${VAULT_CAPABILITY_HASH_DOMAIN}\0${VAULT_PROTOCOL_VERSION}\0${vaultId.toLowerCase()}\0${invitationCapability}`,
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
  );
};

const deriveVaultPurposeKey = async (
  rootKey: string,
  vaultId: string,
  purpose: VaultPurpose,
): Promise<CryptoKey> => {
  const crypto = requireCrypto();
  const rawKey = validateSecret(rootKey, "VAULT_KEY_INVALID");
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    rawKey,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = new TextEncoder().encode(
    `${VAULT_KEY_DERIVATION_DOMAIN}\0${VAULT_PROTOCOL_VERSION}\0${vaultId.toLowerCase()}`,
  );
  const info = new TextEncoder().encode(
    `${VAULT_KEY_DERIVATION_DOMAIN}\0${purpose}`,
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export const encryptVaultBytes = async (
  rootKey: string,
  context: VaultEnvelopeContextV1,
  plaintext: Uint8Array<ArrayBuffer> | ArrayBuffer,
): Promise<VaultEncryptedEnvelopeV1> => {
  const crypto = requireCrypto();
  assertVaultEnvelopeContextV1(context);
  const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  const key = await deriveVaultPurposeKey(
    rootKey,
    context.vaultId,
    context.purpose,
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeVaultEnvelopeAadV1(context),
      tagLength: 128,
    },
    key,
    plaintext,
  );
  return {
    ...context,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  } as VaultEncryptedEnvelopeV1;
};

export const decryptVaultBytes = async (
  rootKey: string,
  envelope: VaultEncryptedEnvelopeV1,
): Promise<ArrayBuffer> => {
  const crypto = requireCrypto();
  assertVaultEncryptedEnvelopeV1(envelope);
  const { iv, ciphertext, ...context } = envelope;
  const key = await deriveVaultPurposeKey(
    rootKey,
    envelope.vaultId,
    envelope.purpose,
  );
  try {
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(iv),
        additionalData: encodeVaultEnvelopeAadV1(context),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(ciphertext),
    );
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault ciphertext authentication failed.",
    );
  }
};

export const encryptVaultJson = (
  rootKey: string,
  context: VaultEnvelopeContextV1,
  value: unknown,
) =>
  encryptVaultBytes(
    rootKey,
    context,
    new TextEncoder().encode(JSON.stringify(value)),
  );

export const decryptVaultJson = async <T>(
  rootKey: string,
  envelope: VaultEncryptedEnvelopeV1,
): Promise<T> => {
  const plaintext = await decryptVaultBytes(rootKey, envelope);
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext))) as T;
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault plaintext is not valid JSON.",
    );
  }
};
