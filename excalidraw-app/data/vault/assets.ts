import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "./capabilities";
import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";

import type { VaultAssetEncryptedEnvelopeV1 } from "./types";

export interface VaultEncryptedAssetInput {
  vaultId: string;
  invitationCapability: string;
  fileId: string;
}

export interface VaultEncryptedAssetUploadInput
  extends VaultEncryptedAssetInput {
  envelope: VaultAssetEncryptedEnvelopeV1;
}

export interface VaultEncryptedAssetReceipt {
  vaultId: string;
  fileId: string;
  encryptedDigest: string;
  ciphertextBytes: number;
}

export interface VaultEncryptedAssetDownload
  extends VaultEncryptedAssetReceipt {
  envelope: VaultAssetEncryptedEnvelopeV1;
}

/**
 * Dedicated encrypted Vault asset surface. It intentionally does not extend
 * ordinary AssetStorage and exposes no URL, Blob, MIME, filename, local cache,
 * or fallback-compatible method.
 */
export interface VaultEncryptedAssetService {
  readonly kind: "vault-encrypted-asset-service";
  readonly protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  upload(
    input: VaultEncryptedAssetUploadInput,
  ): Promise<VaultEncryptedAssetReceipt>;
  download(
    input: VaultEncryptedAssetInput,
  ): Promise<VaultEncryptedAssetDownload>;
}

export type VaultEncryptedAssetServiceImplementation = Omit<
  VaultEncryptedAssetService,
  "kind" | "protocolVersion"
>;

const issuedVaultEncryptedAssetServices = new WeakSet<object>();

export const createVaultEncryptedAssetService = (
  deployment: VaultDeploymentReady,
  implementation: VaultEncryptedAssetServiceImplementation,
): VaultEncryptedAssetService => {
  assertVaultDeploymentReadyToken(deployment);
  const service = Object.freeze({
    kind: "vault-encrypted-asset-service" as const,
    protocolVersion: VAULT_PROTOCOL_VERSION,
    upload: (input: VaultEncryptedAssetUploadInput) =>
      implementation.upload(input),
    download: (input: VaultEncryptedAssetInput) =>
      implementation.download(input),
  });
  issuedVaultEncryptedAssetServices.add(service);
  return service;
};

export const isVaultEncryptedAssetService = (
  value: unknown,
): value is VaultEncryptedAssetService =>
  typeof value === "object" &&
  value !== null &&
  issuedVaultEncryptedAssetServices.has(value);

export function assertVaultEncryptedAssetService(
  value: unknown,
): asserts value is VaultEncryptedAssetService {
  if (!isVaultEncryptedAssetService(value)) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault encrypted asset service is missing or invalid.",
    );
  }
}
