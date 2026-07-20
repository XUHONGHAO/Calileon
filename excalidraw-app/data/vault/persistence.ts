import { VAULT_RPC } from "./backendContract";
import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "./capabilities";
import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";

import type {
  VaultAssetRegistrationInput,
  VaultAssetRegistrationResult,
  VaultSnapshotCasInput,
  VaultSnapshotCasResult,
} from "./backendContract";
import type {
  VaultCapabilityResolution,
  VaultSnapshotEncryptedEnvelopeV1,
} from "./types";

export type VaultRpcName = typeof VAULT_RPC[keyof typeof VAULT_RPC];

const VAULT_RPC_ALLOWLIST = Object.freeze(
  Object.values(VAULT_RPC) as readonly VaultRpcName[],
);
const vaultRpcAllowlist = new Set<string>(VAULT_RPC_ALLOWLIST);

export { VAULT_RPC_ALLOWLIST };

export interface VaultCapabilityInput {
  vaultId: string;
  invitationCapability: string;
}

export interface VaultSnapshotRecord {
  vaultId: string;
  generation: number;
  encryptedEnvelope: VaultSnapshotEncryptedEnvelopeV1;
  ciphertextBytes: number;
  updatedAt: number;
}

export interface VaultAssetResolution {
  vaultId: string;
  fileId: string;
  storagePath: string;
  encryptedDigest: string;
  ciphertextBytes: number;
}

export interface VaultAssetResolveInput extends VaultCapabilityInput {
  fileId: string;
}

/**
 * Browser-facing Vault persistence surface.
 *
 * This deliberately does not extend or reference CollabPersistenceService.
 * In particular it has no saveScene/loadScene/saveFiles fallback-compatible
 * methods. Asset completion remains a controlled service-role operation and
 * is therefore not exposed on this client contract.
 */
export interface VaultPersistenceService {
  readonly kind: "vault-persistence";
  readonly protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  resolveCapability(
    input: VaultCapabilityInput,
  ): Promise<VaultCapabilityResolution>;
  loadSnapshot(
    input: VaultCapabilityInput,
  ): Promise<VaultSnapshotRecord | null>;
  casSnapshot(input: VaultSnapshotCasInput): Promise<VaultSnapshotCasResult>;
  registerAsset(
    input: VaultAssetRegistrationInput,
  ): Promise<VaultAssetRegistrationResult>;
  resolveAsset(input: VaultAssetResolveInput): Promise<VaultAssetResolution>;
}

export type VaultPersistenceServiceImplementation = Omit<
  VaultPersistenceService,
  "kind" | "protocolVersion"
>;

const issuedVaultPersistenceServices = new WeakSet<object>();

/**
 * Creates the only runtime-recognized client Vault persistence service.
 * A service cannot be issued until deployment preflight has produced a valid
 * VaultDeploymentReady token.
 */
export const createVaultPersistenceService = (
  deployment: VaultDeploymentReady,
  implementation: VaultPersistenceServiceImplementation,
): VaultPersistenceService => {
  assertVaultDeploymentReadyToken(deployment);

  const service = Object.freeze({
    kind: "vault-persistence" as const,
    protocolVersion: VAULT_PROTOCOL_VERSION,
    resolveCapability: (input: VaultCapabilityInput) =>
      implementation.resolveCapability(input),
    loadSnapshot: (input: VaultCapabilityInput) =>
      implementation.loadSnapshot(input),
    casSnapshot: (input: VaultSnapshotCasInput) =>
      implementation.casSnapshot(input),
    registerAsset: (input: VaultAssetRegistrationInput) =>
      implementation.registerAsset(input),
    resolveAsset: (input: VaultAssetResolveInput) =>
      implementation.resolveAsset(input),
  });

  issuedVaultPersistenceServices.add(service);
  return service;
};

export const isVaultPersistenceService = (
  value: unknown,
): value is VaultPersistenceService =>
  typeof value === "object" &&
  value !== null &&
  issuedVaultPersistenceServices.has(value);

export function assertVaultPersistenceService(
  value: unknown,
): asserts value is VaultPersistenceService {
  if (!isVaultPersistenceService(value)) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault persistence service is missing or invalid.",
    );
  }
}

export interface VaultRpcTransport {
  invoke<TResult = unknown>(
    rpcName: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<TResult>;
}

export interface VaultRpcInvoker {
  readonly kind: "vault-rpc-invoker";
  readonly protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  invoke<TResult = unknown>(
    rpcName: VaultRpcName,
    params: Readonly<Record<string, unknown>>,
  ): Promise<TResult>;
}

export function assertVaultRpcAllowed(
  rpcName: unknown,
): asserts rpcName is VaultRpcName {
  if (typeof rpcName !== "string" || !vaultRpcAllowlist.has(rpcName)) {
    throw new VaultError(
      "VAULT_PLAIN_FALLBACK_FORBIDDEN",
      "Vault persistence rejected a non-Vault RPC.",
    );
  }
}

/**
 * F2 adapters should send every Supabase persistence call through this
 * invoker. Runtime allowlisting prevents type assertions, typos, or legacy
 * fallback names from reaching the transport.
 */
export const createVaultRpcInvoker = (
  deployment: VaultDeploymentReady,
  transport: VaultRpcTransport,
): VaultRpcInvoker => {
  assertVaultDeploymentReadyToken(deployment);

  return Object.freeze({
    kind: "vault-rpc-invoker" as const,
    protocolVersion: VAULT_PROTOCOL_VERSION,
    invoke: async <TResult>(
      rpcName: VaultRpcName,
      params: Readonly<Record<string, unknown>>,
    ) => {
      assertVaultDeploymentReadyToken(deployment);
      assertVaultRpcAllowed(rpcName);
      return await transport.invoke<TResult>(rpcName, params);
    },
  });
};
