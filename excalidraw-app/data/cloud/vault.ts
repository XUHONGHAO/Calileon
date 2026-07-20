import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "../vault/capabilities";
import { assertVaultEncryptedAssetService } from "../vault/assets";
import { VaultError } from "../vault/errors";
import { assertVaultOwnerService } from "../vault/owner";
import { assertVaultPersistenceService } from "../vault/persistence";

import { createSupabaseVaultEncryptedAssetService } from "./supabase/SupabaseVaultEncryptedAssetService";
import { createSupabaseVaultOwnerService } from "./supabase/SupabaseVaultOwnerService";
import { createSupabaseVaultPersistenceService } from "./supabase/SupabaseVaultPersistenceService";

import type { VaultEncryptedAssetService } from "../vault/assets";
import type { VaultOwnerService } from "../vault/owner";
import type { VaultPersistenceService } from "../vault/persistence";
import type {
  SupabaseVaultAssetClient,
  VaultAssetFetcher,
} from "./supabase/SupabaseVaultEncryptedAssetService";
import type { SupabaseVaultRpcClient } from "./supabase/SupabaseVaultPersistenceService";
import type { SupabaseVaultControlPlaneClient } from "./supabase/SupabaseVaultOwnerService";

const vaultBackendBrand: unique symbol = Symbol("VaultBackend");
const issuedVaultBackends = new WeakSet<object>();

export interface VaultBackend {
  readonly kind: "vault-backend";
  readonly deployment: VaultDeploymentReady;
  readonly assets: VaultEncryptedAssetService;
  readonly owner: VaultOwnerService;
  readonly persistence: VaultPersistenceService;
  readonly [vaultBackendBrand]: true;
}

/**
 * Dedicated Vault assembly. It intentionally has no local, Firebase, ordinary
 * collaboration, or plain-scene fallback branch.
 */
export const createSupabaseVaultBackend = (
  deployment: VaultDeploymentReady,
  options?: {
    client?: SupabaseVaultRpcClient;
    controlPlaneClient?: SupabaseVaultControlPlaneClient;
    assetClient?: SupabaseVaultAssetClient;
    assetFetcher?: VaultAssetFetcher;
  },
): VaultBackend => {
  assertVaultDeploymentReadyToken(deployment);
  const assets = createSupabaseVaultEncryptedAssetService(deployment, {
    client: options?.assetClient,
    fetcher: options?.assetFetcher,
  });
  const owner = createSupabaseVaultOwnerService(deployment, options);
  const persistence = createSupabaseVaultPersistenceService(
    deployment,
    options,
  );
  assertVaultEncryptedAssetService(assets);
  assertVaultOwnerService(owner);
  assertVaultPersistenceService(persistence);
  const backend = Object.freeze({
    kind: "vault-backend" as const,
    deployment,
    assets,
    owner,
    persistence,
    [vaultBackendBrand]: true as const,
  });
  issuedVaultBackends.add(backend);
  return backend;
};

export const isVaultBackend = (value: unknown): value is VaultBackend =>
  typeof value === "object" && value !== null && issuedVaultBackends.has(value);

export function assertVaultBackend(
  value: unknown,
): asserts value is VaultBackend {
  if (!isVaultBackend(value)) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault backend is missing or invalid.",
    );
  }
  assertVaultDeploymentReadyToken(value.deployment);
  assertVaultEncryptedAssetService(value.assets);
  assertVaultOwnerService(value.owner);
  assertVaultPersistenceService(value.persistence);
}
