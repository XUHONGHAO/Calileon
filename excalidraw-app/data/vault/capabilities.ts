import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";

import type { VaultDeploymentCapabilities } from "./types";

const vaultDeploymentReadyBrand: unique symbol = Symbol("VaultDeploymentReady");
const issuedVaultDeploymentReadyTokens = new WeakSet<object>();

/**
 * Runtime proof that the complete Vault deployment preflight succeeded.
 *
 * The private brand prevents accidental structural construction in TypeScript,
 * while the WeakSet lets runtime boundaries reject forged values created via a
 * type assertion. Future Vault start paths must accept this token (or a
 * service created from it), never raw deployment capability booleans.
 */
export interface VaultDeploymentReady {
  readonly kind: "vault-deployment-ready";
  readonly protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  readonly [vaultDeploymentReadyBrand]: true;
}

export interface VaultRuntimeSecurityContext {
  isSecureContext: boolean;
  hasWebCrypto: boolean;
}

export type VaultPersistenceTarget = "vault" | "plain" | "legacy";

export const assertVaultPersistenceTarget = (
  target: VaultPersistenceTarget,
) => {
  if (target !== "vault") {
    throw new VaultError(
      "VAULT_PLAIN_FALLBACK_FORBIDDEN",
      "Vault cannot use plain or legacy persistence.",
    );
  }
};

export const assertVaultDeploymentReady = (
  capabilities: VaultDeploymentCapabilities,
  runtime: VaultRuntimeSecurityContext = {
    isSecureContext: window.isSecureContext,
    hasWebCrypto: !!window.crypto?.subtle,
  },
): VaultDeploymentReady => {
  if (!runtime.isSecureContext) {
    throw new VaultError(
      "VAULT_SECURE_CONTEXT_REQUIRED",
      "Vault requires a secure context.",
    );
  }
  if (!runtime.hasWebCrypto) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  if (!capabilities.enabled) {
    throw new VaultError("VAULT_PERSISTENCE_UNAVAILABLE", "Vault is disabled.");
  }
  if (!capabilities.protocolVersions.includes(VAULT_PROTOCOL_VERSION)) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Vault persistence protocol is incompatible.",
    );
  }
  if (!capabilities.roomProtocolVersions.includes(VAULT_PROTOCOL_VERSION)) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room protocol is incompatible.",
    );
  }
  if (
    !capabilities.invitationService ||
    !capabilities.encryptedSnapshotPersistence ||
    !capabilities.encryptedAssetPersistence
  ) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Required Vault services are unavailable.",
    );
  }

  const token = Object.freeze({
    kind: "vault-deployment-ready" as const,
    protocolVersion: VAULT_PROTOCOL_VERSION,
    [vaultDeploymentReadyBrand]: true as const,
  });
  issuedVaultDeploymentReadyTokens.add(token);
  return token;
};

export const isVaultDeploymentReady = (
  value: unknown,
): value is VaultDeploymentReady =>
  typeof value === "object" &&
  value !== null &&
  issuedVaultDeploymentReadyTokens.has(value);

export function assertVaultDeploymentReadyToken(
  value: unknown,
): asserts value is VaultDeploymentReady {
  if (!isVaultDeploymentReady(value)) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault deployment preflight proof is missing or invalid.",
    );
  }
}
