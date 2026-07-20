import { beforeEach, describe, expect, it, vi } from "vitest";

import { VAULT_RPC } from "../../vault/backendContract";
import { assertVaultDeploymentReady } from "../../vault/capabilities";
import { hashVaultInvitationCapability } from "../../vault/crypto";
import { isVaultOwnerService } from "../../vault/owner";

import { createSupabaseVaultOwnerService } from "./SupabaseVaultOwnerService";

import type { VaultDeploymentCapabilities } from "../../vault/types";
import type { SupabaseVaultRpcClient } from "./SupabaseVaultPersistenceService";
import type { SupabaseVaultControlPlaneClient } from "./SupabaseVaultOwnerService";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const CAPABILITY = "A".repeat(43);
const INVITEE_CAPABILITY = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU";
const EXPIRES_AT = Date.parse("2099-07-14T08:00:00.000Z");

const readyCapabilities: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

const createReadyToken = () =>
  assertVaultDeploymentReady(readyCapabilities, {
    isSecureContext: true,
    hasWebCrypto: true,
  });

const rpc = vi.fn();
const client: SupabaseVaultRpcClient = { rpc };
const invoke = vi.fn();
const controlPlaneClient: SupabaseVaultControlPlaneClient = { invoke };

describe("SupabaseVaultOwnerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires deployment proof and exposes a dedicated owner surface", () => {
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });
    expect(isVaultOwnerService(service)).toBe(true);
    expect(Object.keys(service).sort()).toEqual(
      [
        "activate",
        "create",
        "createInvitation",
        "failCreation",
        "kind",
        "protocolVersion",
        "revokeInvitation",
        "revokeVault",
        "softDeleteVault",
      ].sort(),
    );
    expect("resolveCapability" in service).toBe(false);
    expect("saveScene" in service).toBe(false);

    const forged = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    } as unknown as Parameters<typeof createSupabaseVaultOwnerService>[0];
    expect(() =>
      createSupabaseVaultOwnerService(forged, { client }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });

  it("hashes the initial editor capability locally and never sends raw secret", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        state: "creating",
        invitationId: INVITATION_ID,
        snapshotGeneration: 0,
      },
      error: null,
    });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });
    const expectedHash = await hashVaultInvitationCapability(
      VAULT_ID,
      CAPABILITY,
    );

    await service.create({
      vaultId: VAULT_ID,
      editorInvitationCapability: CAPABILITY,
      editorExpiresAt: EXPIRES_AT,
    });

    expect(rpc).toHaveBeenCalledWith(VAULT_RPC.createVault, {
      p_vault_id: VAULT_ID,
      p_protocol_version: 1,
      p_editor_capability_hash: expectedHash,
      p_editor_expires_at: new Date(EXPIRES_AT).toISOString(),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(CAPABILITY);
  });

  it("hashes new invitation capabilities locally", async () => {
    rpc.mockResolvedValue({
      data: {
        invitationId: INVITATION_ID,
        vaultId: VAULT_ID,
        role: "viewer",
        authorizationVersion: 1,
        expiresAt: new Date(EXPIRES_AT).toISOString(),
      },
      error: null,
    });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });
    const expectedHash = await hashVaultInvitationCapability(
      VAULT_ID,
      INVITEE_CAPABILITY,
    );

    await service.createInvitation({
      vaultId: VAULT_ID,
      role: "viewer",
      invitationCapability: INVITEE_CAPABILITY,
      expiresAt: EXPIRES_AT,
    });

    expect(rpc).toHaveBeenCalledWith(VAULT_RPC.createInvitation, {
      p_vault_id: VAULT_ID,
      p_role: "viewer",
      p_capability_hash: expectedHash,
      p_expires_at: new Date(EXPIRES_AT).toISOString(),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(INVITEE_CAPABILITY);
  });

  it("activates or compensates a creating Vault only through lifecycle RPCs", async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          vaultId: VAULT_ID,
          state: "active",
          activeRoomId: "vault_room_123456",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });

    await service.activate({
      vaultId: VAULT_ID,
      activeRoomId: "vault_room_123456",
    });
    await service.failCreation(VAULT_ID);

    expect(rpc.mock.calls).toEqual([
      [
        VAULT_RPC.activateVault,
        {
          p_vault_id: VAULT_ID,
          p_active_room_id: "vault_room_123456",
        },
      ],
      [VAULT_RPC.failVaultCreation, { p_vault_id: VAULT_ID }],
    ]);
  });

  it("returns revoke notices containing the control-plane fields", async () => {
    invoke.mockResolvedValueOnce({
      data: {
        vaultId: VAULT_ID,
        invitationId: INVITATION_ID,
        authorizationVersion: 3,
        reason: "revoked",
      },
      error: null,
    });
    rpc
      .mockResolvedValueOnce({
        data: { vaultId: VAULT_ID, reason: "vault-revoked" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          vaultId: VAULT_ID,
          reason: "vault-deleted",
          deleteAfter: "2099-07-21T08:00:00.000Z",
        },
        error: null,
      });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
      controlPlaneClient,
    });

    await expect(
      service.revokeInvitation({
        vaultId: VAULT_ID,
        invitationId: INVITATION_ID,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      authorizationVersion: 3,
      reason: "revoked",
    });
    expect(invoke).toHaveBeenCalledWith("vault-control-plane", {
      body: {
        action: "revoke-invitation",
        vaultId: VAULT_ID,
        invitationId: INVITATION_ID,
      },
    });
    await expect(service.revokeVault(VAULT_ID)).resolves.toEqual({
      vaultId: VAULT_ID,
      reason: "vault-revoked",
    });
    await expect(service.softDeleteVault(VAULT_ID)).resolves.toEqual({
      vaultId: VAULT_ID,
      reason: "vault-deleted",
      deleteAfter: Date.parse("2099-07-21T08:00:00.000Z"),
    });
  });

  it("maps stable control-plane errors without exposing response details", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        context: {
          clone: () => ({
            json: async () => ({
              error: "VAULT_PERSISTENCE_UNAVAILABLE",
              detail: CAPABILITY,
            }),
          }),
        },
      },
    });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
      controlPlaneClient,
    });

    const promise = service.revokeInvitation({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
    });
    await expect(promise).rejects.toMatchObject({
      code: "VAULT_PERSISTENCE_UNAVAILABLE",
    });
    await promise.catch((error) =>
      expect((error as Error).message).not.toContain(CAPABILITY),
    );
  });

  it("rejects extra lifecycle response fields fail-closed", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        reason: "vault-revoked",
        legacyRoomId: "ordinary-room",
      },
      error: null,
    });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });

    await expect(service.revokeVault(VAULT_ID)).rejects.toMatchObject({
      code: "VAULT_INTERNAL",
    });
  });

  it("maps stable lifecycle errors without leaking raw capability", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "VAULT_ALREADY_EXISTS",
        details: CAPABILITY,
      },
    });
    const service = createSupabaseVaultOwnerService(createReadyToken(), {
      client,
    });

    const promise = service.create({
      vaultId: VAULT_ID,
      editorInvitationCapability: CAPABILITY,
      editorExpiresAt: null,
    });
    await expect(promise).rejects.toMatchObject({
      code: "VAULT_ALREADY_EXISTS",
    });
    await promise.catch((error) =>
      expect((error as Error).message).not.toContain(CAPABILITY),
    );
  });
});
