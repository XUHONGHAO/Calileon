import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "./capabilities";
import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";

import type { VaultCapabilityDisconnectNotice } from "./backendContract";
import type { VaultRole } from "./types";

export interface VaultOwnerCreateInput {
  vaultId: string;
  editorInvitationCapability: string;
  editorExpiresAt: number | null;
}

export interface VaultOwnerCreateResult {
  vaultId: string;
  state: "creating";
  invitationId: string;
  snapshotGeneration: 0;
}

export interface VaultOwnerActivateInput {
  vaultId: string;
  activeRoomId: string;
}

export interface VaultOwnerActivateResult {
  vaultId: string;
  state: "active";
  activeRoomId: string;
}

export interface VaultOwnerCreateInvitationInput {
  vaultId: string;
  role: VaultRole;
  invitationCapability: string;
  expiresAt: number | null;
}

export interface VaultOwnerInvitationResult {
  vaultId: string;
  invitationId: string;
  role: VaultRole;
  authorizationVersion: number;
  expiresAt: number | null;
}

export interface VaultOwnerRevokeInvitationInput {
  vaultId: string;
  invitationId: string;
}

export interface VaultOwnerInvitationRevocation
  extends VaultCapabilityDisconnectNotice {
  reason: "revoked";
}

export interface VaultOwnerVaultRevocation {
  vaultId: string;
  reason: "vault-revoked";
}

export interface VaultOwnerVaultDeletion {
  vaultId: string;
  reason: "vault-deleted";
  deleteAfter: number;
}

export interface VaultOwnerService {
  readonly kind: "vault-owner-service";
  readonly protocolVersion: typeof VAULT_PROTOCOL_VERSION;
  create(input: VaultOwnerCreateInput): Promise<VaultOwnerCreateResult>;
  activate(input: VaultOwnerActivateInput): Promise<VaultOwnerActivateResult>;
  failCreation(vaultId: string): Promise<void>;
  createInvitation(
    input: VaultOwnerCreateInvitationInput,
  ): Promise<VaultOwnerInvitationResult>;
  revokeInvitation(
    input: VaultOwnerRevokeInvitationInput,
  ): Promise<VaultOwnerInvitationRevocation>;
  revokeVault(vaultId: string): Promise<VaultOwnerVaultRevocation>;
  softDeleteVault(vaultId: string): Promise<VaultOwnerVaultDeletion>;
}

export type VaultOwnerServiceImplementation = Omit<
  VaultOwnerService,
  "kind" | "protocolVersion"
>;

const issuedVaultOwnerServices = new WeakSet<object>();

export const createVaultOwnerService = (
  deployment: VaultDeploymentReady,
  implementation: VaultOwnerServiceImplementation,
): VaultOwnerService => {
  assertVaultDeploymentReadyToken(deployment);
  const service = Object.freeze({
    kind: "vault-owner-service" as const,
    protocolVersion: VAULT_PROTOCOL_VERSION,
    create: (input: VaultOwnerCreateInput) => implementation.create(input),
    activate: (input: VaultOwnerActivateInput) =>
      implementation.activate(input),
    failCreation: (vaultId: string) => implementation.failCreation(vaultId),
    createInvitation: (input: VaultOwnerCreateInvitationInput) =>
      implementation.createInvitation(input),
    revokeInvitation: (input: VaultOwnerRevokeInvitationInput) =>
      implementation.revokeInvitation(input),
    revokeVault: (vaultId: string) => implementation.revokeVault(vaultId),
    softDeleteVault: (vaultId: string) =>
      implementation.softDeleteVault(vaultId),
  });
  issuedVaultOwnerServices.add(service);
  return service;
};

export const isVaultOwnerService = (
  value: unknown,
): value is VaultOwnerService =>
  typeof value === "object" &&
  value !== null &&
  issuedVaultOwnerServices.has(value);

export function assertVaultOwnerService(
  value: unknown,
): asserts value is VaultOwnerService {
  if (!isVaultOwnerService(value)) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault owner service is missing or invalid.",
    );
  }
}

export interface VaultRoomProvisionResult {
  readonly kind: "vault-room";
  readonly activeRoomId: string;
}

export interface ProvisionVaultInput extends VaultOwnerCreateInput {
  createVaultRoom(context: {
    vaultId: string;
    invitationId: string;
  }): Promise<VaultRoomProvisionResult>;
}

/**
 * Creates Vault metadata, provisions only the caller-supplied Vault room, then
 * activates the Vault. Room creation failure always triggers the frozen
 * fail_vault_creation compensation; this helper has no ordinary-room or plain
 * scene fallback surface.
 */
export const provisionVault = async (
  service: VaultOwnerService,
  input: ProvisionVaultInput,
): Promise<{
  created: VaultOwnerCreateResult;
  activated: VaultOwnerActivateResult;
}> => {
  assertVaultOwnerService(service);
  const created = await service.create({
    vaultId: input.vaultId,
    editorInvitationCapability: input.editorInvitationCapability,
    editorExpiresAt: input.editorExpiresAt,
  });
  let room: VaultRoomProvisionResult;
  try {
    room = await input.createVaultRoom({
      vaultId: created.vaultId,
      invitationId: created.invitationId,
    });
  } catch (error) {
    await service.failCreation(created.vaultId);
    throw error;
  }
  if (
    typeof room !== "object" ||
    room === null ||
    Object.keys(room).length !== 2 ||
    room.kind !== "vault-room" ||
    typeof room.activeRoomId !== "string"
  ) {
    await service.failCreation(created.vaultId);
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provisioning returned an invalid result.",
    );
  }
  try {
    const activated = await service.activate({
      vaultId: created.vaultId,
      activeRoomId: room.activeRoomId,
    });
    return { created, activated };
  } catch (error) {
    await service.failCreation(created.vaultId);
    throw error;
  }
};
