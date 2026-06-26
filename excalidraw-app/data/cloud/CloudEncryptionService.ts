import {
  decryptData,
  encryptData,
  generateEncryptionKey,
} from "@excalidraw/excalidraw/data/encryption";
import { t } from "@excalidraw/excalidraw/i18n";

import { STORAGE_KEYS } from "../../app_constants";

import type {
  CloudEncryptionService,
  CloudKeyringEntry,
  EncryptedScenePayloadV1,
} from "./types";

interface StoredCloudKeyring {
  schemaVersion: 1;
  entries: CloudKeyringEntry[];
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = window.atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const readBlobAsText = async (blob: Blob): Promise<string> => {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
};

const requireCryptoSubtle = () => {
  if (!window.crypto?.subtle) {
    throw new Error(t("cloud.e2e.secureContextRequired"));
  }
};

export const isEncryptedScenePayloadV1 = (
  payload: unknown,
): payload is EncryptedScenePayloadV1 =>
  !!payload &&
  typeof payload === "object" &&
  !Array.isArray(payload) &&
  (payload as { version?: unknown }).version === 1 &&
  (payload as { algorithm?: unknown }).algorithm === "AES-GCM" &&
  typeof (payload as { iv?: unknown }).iv === "string" &&
  typeof (payload as { ciphertext?: unknown }).ciphertext === "string";

const isCloudKeyringEntry = (value: unknown): value is CloudKeyringEntry =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as { sceneId?: unknown }).sceneId === "string" &&
  typeof (value as { key?: unknown }).key === "string" &&
  typeof (value as { createdAt?: unknown }).createdAt === "number" &&
  typeof (value as { updatedAt?: unknown }).updatedAt === "number";

const readKeyring = (): StoredCloudKeyring => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_CLOUD_KEYRING);
    if (!raw) {
      return { schemaVersion: 1, entries: [] };
    }

    const parsed = JSON.parse(raw) as Partial<StoredCloudKeyring>;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isCloudKeyringEntry)
    ) {
      return { schemaVersion: 1, entries: [] };
    }
    return parsed as StoredCloudKeyring;
  } catch (error) {
    console.warn(error);
    return { schemaVersion: 1, entries: [] };
  }
};

const writeKeyring = (keyring: StoredCloudKeyring) => {
  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_CLOUD_KEYRING,
    JSON.stringify(keyring),
  );
};

export const createCloudEncryptionService = (
  available: boolean,
): CloudEncryptionService => ({
  isAvailable: () => available,
  generateKey: () => {
    requireCryptoSubtle();
    return generateEncryptionKey("string");
  },
  encryptScenePayload: async (payload, key) => {
    requireCryptoSubtle();
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const { encryptedBuffer, iv } = await encryptData(key, encoded);
    return {
      version: 1,
      algorithm: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
    };
  },
  decryptScenePayload: async (payload, key) => {
    requireCryptoSubtle();
    const decrypted = await decryptData(
      base64ToBytes(payload.iv),
      bytesToArrayBuffer(base64ToBytes(payload.ciphertext)),
      key,
    );
    return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
  },
  encryptBlob: async (blob, key) => {
    requireCryptoSubtle();
    const { encryptedBuffer, iv } = await encryptData(key, blob);
    const payload: EncryptedScenePayloadV1 = {
      version: 1,
      algorithm: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
    };
    return new Blob([JSON.stringify(payload)], {
      type: "application/octet-stream",
    });
  },
  decryptBlob: async (blob, key) => {
    requireCryptoSubtle();
    const payload = JSON.parse(await readBlobAsText(blob));
    if (!isEncryptedScenePayloadV1(payload)) {
      throw new Error("Invalid encrypted blob payload.");
    }
    const decrypted = await decryptData(
      base64ToBytes(payload.iv),
      bytesToArrayBuffer(base64ToBytes(payload.ciphertext)),
      key,
    );
    return new Blob([decrypted]);
  },
  saveKey: (entry) => {
    const keyring = readKeyring();
    const existingIndex = keyring.entries.findIndex(
      (candidate) => candidate.sceneId === entry.sceneId,
    );
    const nextEntry = { ...entry, updatedAt: Date.now() };
    if (existingIndex >= 0) {
      keyring.entries[existingIndex] = {
        ...keyring.entries[existingIndex],
        ...nextEntry,
      };
    } else {
      keyring.entries.push(nextEntry);
    }
    writeKeyring(keyring);
  },
  getKey: (sceneId) =>
    readKeyring().entries.find((entry) => entry.sceneId === sceneId) ?? null,
  removeKey: (sceneId) => {
    const keyring = readKeyring();
    writeKeyring({
      schemaVersion: 1,
      entries: keyring.entries.filter((entry) => entry.sceneId !== sceneId),
    });
  },
});
