/**
 * Vault v2 attachment test helpers (not imported by production code).
 */
import { newElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { createVaultEncryptedAssetService } from "../assets";
import { assertVaultDeploymentReady } from "../capabilities";
import { VaultError } from "../errors";
import { digestVaultAssetEnvelope } from "../fileAssets";

import type { VaultAssetEncryptedEnvelopeV1 } from "../types";

export const TEST_FILE_ID = "file_0123456789abcdef" as FileId;

export const deployment = () =>
  assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1, 2],
      roomProtocolVersions: [1, 2],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );

/** register/complete/resolve semantics of the asset RPCs (digest-idempotent) */
export class FakeAssetServer {
  readonly objects = new Map<
    string,
    {
      envelope: VaultAssetEncryptedEnvelopeV1;
      encryptedDigest: string;
      ciphertextBytes: number;
    }
  >();
  uploads = 0;
  offline = false;

  readonly service = createVaultEncryptedAssetService(deployment(), {
    upload: async ({ vaultId, fileId, envelope }) => {
      if (this.offline) {
        throw new VaultError("VAULT_PERSISTENCE_UNAVAILABLE", "offline", {
          recoverable: true,
        });
      }
      this.uploads += 1;
      const digest = await digestVaultAssetEnvelope(envelope);
      const key = `${vaultId}/${fileId}`;
      const existing = this.objects.get(key);
      if (existing && existing.encryptedDigest !== digest.encryptedDigest) {
        throw new VaultError("VAULT_ASSET_CONFLICT", "conflict");
      }
      this.objects.set(key, { envelope, ...digest });
      return { vaultId, fileId, ...digest };
    },
    download: async ({ vaultId, fileId }) => {
      const object = this.objects.get(`${vaultId}/${fileId}`);
      if (!object) {
        throw new VaultError("VAULT_NOT_FOUND", "missing");
      }
      return { vaultId, fileId, ...object };
    },
  });
}

export const imageFile = (id: FileId = TEST_FILE_ID): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,djItYXNzZXQtYnl0ZXM=",
    created: 1,
    version: 1,
  } as unknown as BinaryFileData);

export const imageElement = (
  id: string,
  fileId: FileId,
  status: "pending" | "saved",
): ExcalidrawElement =>
  ({
    ...newElement({ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }),
    id,
    type: "image",
    fileId,
    status,
    scale: [1, 1],
    crop: null,
  } as unknown as ExcalidrawElement);
