import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { decryptVaultJson, encryptVaultJson } from "./crypto";
import {
  assertVaultEncryptedEnvelopeV1,
  createVaultMessageId,
} from "./protocol";
import { VaultError } from "./errors";

import type { VaultEncryptedAssetService } from "./assets";
import type { VaultAssetEncryptedEnvelopeV1 } from "./types";

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

export const downloadVaultFile = async (input: {
  service: VaultEncryptedAssetService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
  fileId: FileId;
}): Promise<BinaryFileData> => {
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
  return assertBinaryFileData(file, input.fileId);
};
