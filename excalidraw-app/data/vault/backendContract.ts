import type {
  VaultCapabilityResolution,
  VaultProtocolVersion,
  VaultRole,
  VaultSnapshotEncryptedEnvelopeV1,
  VaultRealtimeEncryptedEnvelopeV1,
} from "./types";

export const VAULT_RPC = {
  createVault: "create_vault",
  activateVault: "activate_vault",
  failVaultCreation: "fail_vault_creation",
  createInvitation: "create_vault_invitation",
  resolveCapability: "resolve_vault_capability",
  loadSnapshot: "load_vault_snapshot",
  casSnapshot: "cas_vault_snapshot",
  registerAsset: "register_vault_asset",
  completeAsset: "complete_vault_asset",
  resolveAsset: "resolve_vault_asset",
  revokeInvitation: "revoke_vault_invitation",
  revokeVault: "revoke_vault",
  softDeleteVault: "soft_delete_vault",
} as const;

export const VAULT_SOCKET_EVENTS = {
  join: "vault:join",
  server: "vault:server",
  serverVolatile: "vault:server-volatile",
  capabilityRevoked: "vault:capability-revoked",
  capabilityExpired: "vault:capability-expired",
} as const;

export interface VaultSocketJoinRequest {
  protocolVersion: VaultProtocolVersion;
  vaultId: string;
  invitationCapability: string;
  senderSessionId: string;
}

export type VaultSocketJoinResult = VaultCapabilityResolution;

export interface VaultSocketBroadcast {
  sourceSocketId: string;
  admittedSenderSessionId: string;
  envelope: VaultRealtimeEncryptedEnvelopeV1;
}

export interface VaultCapabilityDisconnectNotice {
  vaultId: string;
  invitationId: string;
  authorizationVersion: number;
  reason: "revoked" | "expired" | "vault-revoked" | "vault-deleted";
}

export interface VaultSnapshotCasInput {
  vaultId: string;
  invitationCapability: string;
  expectedGeneration: number;
  envelope: VaultSnapshotEncryptedEnvelopeV1;
  ciphertextBytes: number;
}

export interface VaultSnapshotCasResult {
  vaultId: string;
  generation: number;
  updatedAt: number;
}

export interface VaultAssetRegistrationInput {
  vaultId: string;
  invitationCapability: string;
  fileId: string;
  encryptedDigest: string;
  ciphertextBytes: number;
}

export interface VaultAssetRegistrationResult {
  vaultId: string;
  fileId: string;
  storagePath: string;
  state: "pending" | "ready";
}

export interface VaultAssetCompletionInput {
  vaultId: string;
  invitationCapability: string;
  fileId: string;
  observedEncryptedDigest: string;
  observedCiphertextBytes: number;
}

export interface VaultInvitationRecordContract {
  invitationId: string;
  vaultId: string;
  role: VaultRole;
  authorizationVersion: number;
  expiresAt: number | null;
  revokedAt: number | null;
}
