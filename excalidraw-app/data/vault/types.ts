import type { VAULT_PROTOCOL_VERSION } from "./constants";

export type VaultProtocolVersion = typeof VAULT_PROTOCOL_VERSION;
export type VaultRole = "viewer" | "editor";
export type VaultPurpose = "realtime" | "snapshot" | "asset";

/**
 * Outer message classes are intentionally coarse. The concrete collaboration
 * subtype (scene init/update, pointer, follow, username, viewport, and so on)
 * stays inside the ciphertext.
 */
export type VaultMessageType =
  | "realtime.content"
  | "realtime.presence"
  | "snapshot.scene"
  | "asset.content";

export interface VaultLinkData {
  version: VaultProtocolVersion;
  vaultId: string;
  rootKey: string;
  invitationCapability: string;
}

interface VaultEncryptedEnvelopeBaseV1 {
  version: VaultProtocolVersion;
  vaultId: string;
  purpose: VaultPurpose;
  messageType: VaultMessageType;
  messageId: string;
  iv: string;
  ciphertext: string;
}

export interface VaultRealtimeEncryptedEnvelopeV1
  extends VaultEncryptedEnvelopeBaseV1 {
  purpose: "realtime";
  messageType: "realtime.content" | "realtime.presence";
  senderSessionId: string;
  sequence: number;
}

export interface VaultSnapshotEncryptedEnvelopeV1
  extends VaultEncryptedEnvelopeBaseV1 {
  purpose: "snapshot";
  messageType: "snapshot.scene";
  generation: number;
}

export interface VaultAssetEncryptedEnvelopeV1
  extends VaultEncryptedEnvelopeBaseV1 {
  purpose: "asset";
  messageType: "asset.content";
}

export type VaultEncryptedEnvelopeV1 =
  | VaultRealtimeEncryptedEnvelopeV1
  | VaultSnapshotEncryptedEnvelopeV1
  | VaultAssetEncryptedEnvelopeV1;

export type VaultEnvelopeContextV1 =
  | Omit<VaultRealtimeEncryptedEnvelopeV1, "iv" | "ciphertext">
  | Omit<VaultSnapshotEncryptedEnvelopeV1, "iv" | "ciphertext">
  | Omit<VaultAssetEncryptedEnvelopeV1, "iv" | "ciphertext">;

export interface VaultDeploymentCapabilities {
  enabled: boolean;
  protocolVersions: readonly number[];
  roomProtocolVersions: readonly number[];
  invitationService: boolean;
  encryptedSnapshotPersistence: boolean;
  encryptedAssetPersistence: boolean;
}

export interface VaultCapabilityResolution {
  vaultId: string;
  invitationId: string;
  role: VaultRole;
  authorizationVersion: number;
  activeRoomId: string;
  snapshotGeneration: number;
  expiresAt: number | null;
}
