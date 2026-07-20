import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import {
  createVaultOwnerService,
  provisionVault,
  type VaultOwnerServiceImplementation,
} from "./owner";

import type { VaultDeploymentCapabilities } from "./types";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";

const capabilities: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

const deployment = () =>
  assertVaultDeploymentReady(capabilities, {
    isSecureContext: true,
    hasWebCrypto: true,
  });

const createImplementation = (): VaultOwnerServiceImplementation => ({
  create: vi.fn().mockResolvedValue({
    vaultId: VAULT_ID,
    state: "creating",
    invitationId: INVITATION_ID,
    snapshotGeneration: 0,
  }),
  activate: vi.fn().mockResolvedValue({
    vaultId: VAULT_ID,
    state: "active",
    activeRoomId: "vault_room_123456",
  }),
  failCreation: vi.fn().mockResolvedValue(undefined),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  revokeVault: vi.fn(),
  softDeleteVault: vi.fn(),
});

describe("Vault owner lifecycle orchestration", () => {
  it("creates a Vault room and activates without any fallback", async () => {
    const implementation = createImplementation();
    const service = createVaultOwnerService(deployment(), implementation);
    const createVaultRoom = vi.fn().mockResolvedValue({
      kind: "vault-room",
      activeRoomId: "vault_room_123456",
    });

    await expect(
      provisionVault(service, {
        vaultId: VAULT_ID,
        editorInvitationCapability: "A".repeat(43),
        editorExpiresAt: null,
        createVaultRoom,
      }),
    ).resolves.toMatchObject({
      created: { state: "creating" },
      activated: { state: "active" },
    });
    expect(createVaultRoom).toHaveBeenCalledWith({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
    });
    expect(implementation.failCreation).not.toHaveBeenCalled();
  });

  it("marks creation failed when Vault room provisioning fails", async () => {
    const implementation = createImplementation();
    const service = createVaultOwnerService(deployment(), implementation);
    const roomError = new Error("vault room unavailable");

    await expect(
      provisionVault(service, {
        vaultId: VAULT_ID,
        editorInvitationCapability: "A".repeat(43),
        editorExpiresAt: null,
        createVaultRoom: vi.fn().mockRejectedValue(roomError),
      }),
    ).rejects.toBe(roomError);
    expect(implementation.failCreation).toHaveBeenCalledWith(VAULT_ID);
    expect(implementation.activate).not.toHaveBeenCalled();
  });

  it("marks creation failed when activation fails", async () => {
    const implementation = createImplementation();
    const activationError = new Error("activation failed");
    vi.mocked(implementation.activate).mockRejectedValue(activationError);
    const service = createVaultOwnerService(deployment(), implementation);

    await expect(
      provisionVault(service, {
        vaultId: VAULT_ID,
        editorInvitationCapability: "A".repeat(43),
        editorExpiresAt: null,
        createVaultRoom: vi.fn().mockResolvedValue({
          kind: "vault-room",
          activeRoomId: "vault_room_123456",
        }),
      }),
    ).rejects.toBe(activationError);
    expect(implementation.failCreation).toHaveBeenCalledWith(VAULT_ID);
  });

  it("rejects non-Vault room results and compensates", async () => {
    const implementation = createImplementation();
    const service = createVaultOwnerService(deployment(), implementation);

    await expect(
      provisionVault(service, {
        vaultId: VAULT_ID,
        editorInvitationCapability: "A".repeat(43),
        editorExpiresAt: null,
        createVaultRoom: vi.fn().mockResolvedValue({
          kind: "ordinary-room",
          activeRoomId: "ordinary_room_123",
        } as never),
      }),
    ).rejects.toMatchObject({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" });
    expect(implementation.failCreation).toHaveBeenCalledWith(VAULT_ID);
    expect(implementation.activate).not.toHaveBeenCalled();
  });
});
