import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { assertVaultDeploymentReady } from "./capabilities";
import { createVaultEncryptedAssetService } from "./assets";
import { generateVaultRootKey } from "./crypto";
import { downloadVaultFile, uploadVaultFile } from "./fileAssets";

import type { VaultAssetEncryptedEnvelopeV1 } from "./types";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationCapability = `${"C".repeat(42)}A`;
const fileId = "abcdefghijklmnopqrst" as FileId;
const rootKey = generateVaultRootKey();
const file = {
  id: fileId,
  mimeType: "image/png",
  dataURL: "data:image/png;base64,c2VjcmV0LWltYWdl",
  created: 123,
  lastRetrieved: 456,
  version: 1,
} as BinaryFileData;

const deployment = () =>
  assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1],
      roomProtocolVersions: [1],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );

describe("Vault encrypted file assets", () => {
  it("uploads and downloads BinaryFileData only through the encrypted asset service", async () => {
    let stored: VaultAssetEncryptedEnvelopeV1 | undefined;
    const upload = vi.fn(async (input) => {
      stored = input.envelope;
      return {
        vaultId: input.vaultId,
        fileId: input.fileId,
        encryptedDigest: "A".repeat(43),
        ciphertextBytes: input.envelope.ciphertext.length,
      };
    });
    const download = vi.fn(async () => ({
      vaultId,
      fileId,
      encryptedDigest: "A".repeat(43),
      ciphertextBytes: stored!.ciphertext.length,
      envelope: stored!,
    }));
    const service = createVaultEncryptedAssetService(deployment(), {
      upload,
      download,
    });

    await uploadVaultFile({
      service,
      vaultId,
      invitationCapability,
      rootKey,
      file,
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      version: 1,
      vaultId,
      purpose: "asset",
      messageType: "asset.content",
    });
    expect(JSON.stringify(stored)).not.toContain("secret-image");
    await expect(
      downloadVaultFile({
        service,
        vaultId,
        invitationCapability,
        rootKey,
        fileId,
      }),
    ).resolves.toEqual(file);
  });

  it("fails closed when a downloaded asset is rebound to another file id", async () => {
    let stored!: VaultAssetEncryptedEnvelopeV1;
    const service = createVaultEncryptedAssetService(deployment(), {
      upload: async (input) => {
        stored = input.envelope;
        return {
          vaultId: input.vaultId,
          fileId: input.fileId,
          encryptedDigest: "A".repeat(43),
          ciphertextBytes: stored.ciphertext.length,
        };
      },
      download: async (input) => ({
        vaultId: input.vaultId,
        fileId: input.fileId,
        encryptedDigest: "A".repeat(43),
        ciphertextBytes: stored.ciphertext.length,
        envelope: stored,
      }),
    });
    await uploadVaultFile({
      service,
      vaultId,
      invitationCapability,
      rootKey,
      file,
    });

    await expect(
      downloadVaultFile({
        service,
        vaultId,
        invitationCapability,
        rootKey,
        fileId: "zyxwvutsrqponmlkjihg" as FileId,
      }),
    ).rejects.toMatchObject({ code: "VAULT_DECRYPT_FAILED" });
  });
});
