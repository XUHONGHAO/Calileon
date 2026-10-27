/**
 * Passphrase-based encryption for the account's AI settings (ADR 0038 §3).
 *
 * PBKDF2-SHA-256 turns the sync passphrase plus a per-account random salt
 * into an AES-GCM-256 key. The additional data binds every ciphertext to the
 * account id and format version, so a row copied to another account or
 * relabelled as another version fails to decrypt instead of being accepted.
 */

import type {
  AccountSettingsKdf,
  AccountSettingsWrite,
} from "../data/cloud/types";

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. */
export const DEFAULT_KDF_ITERATIONS = 600_000;
/** Below this a stored row is refused: the server can't weaken new keys. */
export const MIN_KDF_ITERATIONS = 100_000;
/** Above this a device could hang for a long time on a crafted row. */
export const MAX_KDF_ITERATIONS = 5_000_000;
export const MIN_PASSPHRASE_LENGTH = 8;
/** Plaintext cap before encryption; the schema caps the ciphertext at 1 MiB. */
export const MAX_SETTINGS_PLAINTEXT_BYTES = 512 * 1024;

export class SettingsCryptoError extends Error {
  constructor(
    public readonly code:
      | "wrong-passphrase"
      | "unsupported-kdf"
      | "too-large"
      | "insecure-context",
  ) {
    super(code);
    this.name = "SettingsCryptoError";
  }
}

const subtle = () => {
  const value = window.crypto?.subtle;
  if (!value) {
    throw new SettingsCryptoError("insecure-context");
  }
  return value;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
};

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = window.atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const randomBytes = (length: number) =>
  window.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));

const additionalData = (userId: string) =>
  new TextEncoder().encode(`calileon-ai-settings:v1:${userId}`);

/** NFC so the same passphrase typed on two keyboards derives the same key. */
export const normalizePassphrase = (passphrase: string) =>
  passphrase.normalize("NFC");

export const createKdf = (
  iterations: number = DEFAULT_KDF_ITERATIONS,
): AccountSettingsKdf => ({
  name: "PBKDF2",
  hash: "SHA-256",
  iterations,
  salt: bytesToBase64(randomBytes(16)),
});

export const assertSupportedKdf = (kdf: AccountSettingsKdf) => {
  let saltLength = 0;
  try {
    saltLength = base64ToBytes(kdf.salt).length;
  } catch {
    saltLength = 0;
  }
  if (
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_KDF_ITERATIONS ||
    kdf.iterations > MAX_KDF_ITERATIONS ||
    saltLength < 16
  ) {
    throw new SettingsCryptoError("unsupported-kdf");
  }
};

/** Same parameters = same key for the same passphrase. */
export const isSameKdf = (a: AccountSettingsKdf, b: AccountSettingsKdf) =>
  a.name === b.name &&
  a.hash === b.hash &&
  a.iterations === b.iterations &&
  a.salt === b.salt;

/** Returns the raw AES key (base64) so the device can remember it. */
export const deriveSettingsKey = async (
  passphrase: string,
  kdf: AccountSettingsKdf,
): Promise<string> => {
  assertSupportedKdf(kdf);
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(normalizePassphrase(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(kdf.salt),
      iterations: kdf.iterations,
    },
    material,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
};

const importAesKey = (rawKey: string, usage: KeyUsage) =>
  subtle().importKey("raw", base64ToBytes(rawKey), "AES-GCM", false, [usage]);

export const encryptSettings = async (
  plaintext: unknown,
  rawKey: string,
  kdf: AccountSettingsKdf,
  userId: string,
): Promise<AccountSettingsWrite> => {
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  if (encoded.byteLength > MAX_SETTINGS_PLAINTEXT_BYTES) {
    throw new SettingsCryptoError("too-large");
  }
  const iv = randomBytes(12);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(userId) },
    await importAesKey(rawKey, "encrypt"),
    encoded,
  );
  return {
    formatVersion: 1,
    kdf,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

/** Throws `wrong-passphrase` for a wrong key or tampered ciphertext. */
export const decryptSettings = async (
  record: Pick<AccountSettingsWrite, "iv" | "ciphertext">,
  rawKey: string,
  userId: string,
): Promise<unknown> => {
  let decrypted: ArrayBuffer;
  try {
    decrypted = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(record.iv),
        additionalData: additionalData(userId),
      },
      await importAesKey(rawKey, "decrypt"),
      base64ToBytes(record.ciphertext),
    );
  } catch (error) {
    if (error instanceof SettingsCryptoError) {
      throw error;
    }
    throw new SettingsCryptoError("wrong-passphrase");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
};
