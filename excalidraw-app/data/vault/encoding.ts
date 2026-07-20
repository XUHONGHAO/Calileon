import { VaultError } from "./errors";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const isBase64Url = (value: string): boolean =>
  value.length > 0 && BASE64URL_RE.test(value);

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  if (!isBase64Url(value)) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid base64url value.");
  }

  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");

  let binary: string;
  try {
    binary = window.atob(normalized);
  } catch {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid base64url value.");
  }

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const isCanonicalBase64Url = (
  value: string,
  expectedByteLength?: number,
): boolean => {
  if (!isBase64Url(value)) {
    return false;
  }
  try {
    const bytes = base64UrlToBytes(value);
    return (
      (expectedByteLength === undefined ||
        bytes.byteLength === expectedByteLength) &&
      bytesToBase64Url(bytes) === value
    );
  } catch {
    return false;
  }
};
