import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { decryptVaultJson, encryptVaultJson } from "./crypto";
import { bytesToBase64Url } from "./encoding";
import {
  assertVaultEncryptedEnvelopeV1,
  createVaultMessageId,
} from "./protocol";
import { VaultError } from "./errors";

import type { VaultEncryptedAssetService } from "./assets";
import type {
  VaultAssetEncryptedEnvelopeV1,
  VaultEncryptedEnvelopeV1,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertBinaryFileData = (
  value: unknown,
  fileId: FileId,
): BinaryFileData => {
  if (!isRecord(value)) {
    throw new VaultError("VAULT_DECRYPT_FAILED", "Vault asset is invalid.");
  }
  if (
    value.id !== fileId ||
    typeof value.mimeType !== "string" ||
    typeof value.dataURL !== "string" ||
    typeof value.created !== "number" ||
    !Number.isFinite(value.created) ||
    (value.lastRetrieved !== undefined &&
      (typeof value.lastRetrieved !== "number" ||
        !Number.isFinite(value.lastRetrieved))) ||
    (value.version !== undefined &&
      value.version !== null &&
      (typeof value.version !== "number" ||
        !Number.isSafeInteger(value.version) ||
        value.version < 1))
  ) {
    throw new VaultError("VAULT_DECRYPT_FAILED", "Vault asset is invalid.");
  }
  return value as unknown as BinaryFileData;
};

export const encryptVaultFile = async (input: {
  vaultId: string;
  rootKey: string;
  file: BinaryFileData;
}): Promise<VaultAssetEncryptedEnvelopeV1> => {
  return (await encryptVaultJson(
    input.rootKey,
    {
      version: 1,
      vaultId: input.vaultId,
      purpose: "asset",
      messageType: "asset.content",
      messageId: createVaultMessageId(),
    },
    input.file,
  )) as VaultAssetEncryptedEnvelopeV1;
};

/**
 * Canonical byte serialization of an encrypted asset envelope. Upload,
 * download and durable attachment records must hash exactly these bytes so the
 * client digest always matches the server receipts and stored ciphertext.
 */
export const serializeVaultAssetEnvelopeV1 = (
  envelope: VaultEncryptedEnvelopeV1,
): Uint8Array<ArrayBuffer> => {
  assertVaultEncryptedEnvelopeV1(envelope);
  if (envelope.purpose !== "asset") {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault asset.");
  }
  return new TextEncoder().encode(
    JSON.stringify({
      version: envelope.version,
      vaultId: envelope.vaultId,
      purpose: envelope.purpose,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    }),
  );
};

export const digestVaultAssetEnvelope = async (
  envelope: VaultEncryptedEnvelopeV1,
): Promise<{ encryptedDigest: string; ciphertextBytes: number }> => {
  if (!globalThis.crypto?.subtle) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  const bytes = serializeVaultAssetEnvelopeV1(envelope);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return {
    encryptedDigest: bytesToBase64Url(new Uint8Array(digest)),
    ciphertextBytes: bytes.byteLength,
  };
};

export const assertVaultAssetReceipt = (input: {
  vaultId: string;
  fileId: string;
  task: { encryptedDigest: string; ciphertextBytes: number };
  receipt: {
    vaultId: string;
    fileId: string;
    encryptedDigest: string;
    ciphertextBytes: number;
  };
}) => {
  if (
    input.receipt.vaultId !== input.vaultId ||
    input.receipt.fileId !== input.fileId ||
    input.receipt.encryptedDigest !== input.task.encryptedDigest ||
    input.receipt.ciphertextBytes !== input.task.ciphertextBytes
  ) {
    throw new VaultError(
      "VAULT_ASSET_CONFLICT",
      "Vault asset receipt does not match the pending upload.",
    );
  }
};

export const uploadVaultFile = async (input: {
  service: VaultEncryptedAssetService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
  file: BinaryFileData;
}) => {
  const envelope = await encryptVaultFile(input);
  return input.service.upload({
    vaultId: input.vaultId,
    invitationCapability: input.invitationCapability,
    fileId: input.file.id,
    envelope,
  });
};

export const downloadVaultFileWithReceipt = async (input: {
  service: VaultEncryptedAssetService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
  fileId: FileId;
}): Promise<{
  file: BinaryFileData;
  encryptedDigest: string;
  ciphertextBytes: number;
}> => {
  const downloaded = await input.service.download({
    vaultId: input.vaultId,
    invitationCapability: input.invitationCapability,
    fileId: input.fileId,
  });
  assertVaultEncryptedEnvelopeV1(downloaded.envelope);
  if (
    downloaded.envelope.purpose !== "asset" ||
    downloaded.envelope.messageType !== "asset.content" ||
    downloaded.envelope.vaultId !== input.vaultId
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault asset.");
  }
  const file = await decryptVaultJson<unknown>(
    input.rootKey,
    downloaded.envelope,
  );
  return {
    file: assertBinaryFileData(file, input.fileId),
    encryptedDigest: downloaded.encryptedDigest,
    ciphertextBytes: downloaded.ciphertextBytes,
  };
};

export const downloadVaultFile = async (input: {
  service: VaultEncryptedAssetService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
  fileId: FileId;
}): Promise<BinaryFileData> => (await downloadVaultFileWithReceipt(input)).file;
