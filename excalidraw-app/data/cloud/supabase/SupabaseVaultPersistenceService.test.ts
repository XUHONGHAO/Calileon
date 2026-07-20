import { beforeEach, describe, expect, it, vi } from "vitest";

import { VAULT_RPC } from "../../vault/backendContract";
import { assertVaultDeploymentReady } from "../../vault/capabilities";
import { isVaultPersistenceService } from "../../vault/persistence";

import {
  createSupabaseVaultPersistenceService,
  mapSupabaseVaultError,
} from "./SupabaseVaultPersistenceService";

import type { VaultDeploymentCapabilities } from "../../vault/types";
import type { SupabaseVaultRpcClient } from "./SupabaseVaultPersistenceService";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const CAPABILITY = "A".repeat(43);
const FILE_ID = "asset_file_12345";
const TIMESTAMP = "2026-07-13T08:00:00.000Z";

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

const snapshotEnvelope = {
  version: 1 as const,
  vaultId: VAULT_ID,
  purpose: "snapshot" as const,
  messageType: "snapshot.scene" as const,
  messageId: "323e4567-e89b-42d3-a456-426614174000",
  generation: 1,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AQ",
};

const rpc = vi.fn();
const client: SupabaseVaultRpcClient = { rpc };

describe("SupabaseVaultPersistenceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires deployment proof and exposes only the dedicated Vault service", () => {
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    expect(isVaultPersistenceService(service)).toBe(true);
    expect("saveScene" in service).toBe(false);
    expect("loadScene" in service).toBe(false);
    expect("saveFiles" in service).toBe(false);

    const forged = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    } as unknown as Parameters<typeof createSupabaseVaultPersistenceService>[0];
    expect(() =>
      createSupabaseVaultPersistenceService(forged, { client }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("resolves a capability only through the frozen Vault RPC", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        invitationId: INVITATION_ID,
        role: "editor",
        authorizationVersion: 2,
        activeRoomId: "vault_room_123456",
        snapshotGeneration: 0,
        expiresAt: null,
      },
      error: null,
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.resolveCapability({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      role: "editor",
      authorizationVersion: 2,
      activeRoomId: "vault_room_123456",
      snapshotGeneration: 0,
      expiresAt: null,
    });
    expect(rpc).toHaveBeenCalledWith(VAULT_RPC.resolveCapability, {
      p_vault_id: VAULT_ID,
      p_capability: CAPABILITY,
    });
  });

  it("loads and validates an encrypted snapshot", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        generation: 1,
        encryptedEnvelope: snapshotEnvelope,
        ciphertextBytes: 1,
        updatedAt: TIMESTAMP,
      },
      error: null,
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.loadSnapshot({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      generation: 1,
      encryptedEnvelope: snapshotEnvelope,
      ciphertextBytes: 1,
      updatedAt: Date.parse(TIMESTAMP),
    });
    expect(rpc).toHaveBeenCalledWith(VAULT_RPC.loadSnapshot, {
      p_vault_id: VAULT_ID,
      p_capability: CAPABILITY,
    });
  });

  it("performs snapshot CAS with the exact frozen parameters", async () => {
    rpc.mockResolvedValue({
      data: { vaultId: VAULT_ID, generation: 1, updatedAt: TIMESTAMP },
      error: null,
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.casSnapshot({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        expectedGeneration: 0,
        envelope: snapshotEnvelope,
        ciphertextBytes: 1,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      generation: 1,
      updatedAt: Date.parse(TIMESTAMP),
    });
    expect(rpc).toHaveBeenCalledWith(VAULT_RPC.casSnapshot, {
      p_vault_id: VAULT_ID,
      p_capability: CAPABILITY,
      p_expected_generation: 0,
      p_encrypted_envelope: snapshotEnvelope,
      p_ciphertext_bytes: 1,
    });
  });

  it("registers and resolves encrypted assets through Vault RPCs", async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          vaultId: VAULT_ID,
          fileId: FILE_ID,
          storagePath: `vault/${VAULT_ID}/${FILE_ID}`,
          state: "pending",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          vaultId: VAULT_ID,
          fileId: FILE_ID,
          storagePath: `vault/${VAULT_ID}/${FILE_ID}`,
          encryptedDigest: CAPABILITY,
          ciphertextBytes: 10,
        },
        error: null,
      });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await service.registerAsset({
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
      fileId: FILE_ID,
      encryptedDigest: CAPABILITY,
      ciphertextBytes: 10,
    });
    await service.resolveAsset({
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
      fileId: FILE_ID,
    });

    expect(rpc.mock.calls).toEqual([
      [
        VAULT_RPC.registerAsset,
        {
          p_vault_id: VAULT_ID,
          p_capability: CAPABILITY,
          p_file_id: FILE_ID,
          p_encrypted_digest: CAPABILITY,
          p_ciphertext_bytes: 10,
        },
      ],
      [
        VAULT_RPC.resolveAsset,
        {
          p_vault_id: VAULT_ID,
          p_capability: CAPABILITY,
          p_file_id: FILE_ID,
        },
      ],
    ]);
  });

  it("rejects extra response fields fail-closed", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        invitationId: INVITATION_ID,
        role: "viewer",
        authorizationVersion: 1,
        activeRoomId: "vault_room_123456",
        snapshotGeneration: 0,
        expiresAt: null,
        plaintext: { elements: [] },
      },
      error: null,
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.resolveCapability({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
      }),
    ).rejects.toMatchObject({ code: "VAULT_INTERNAL" });
  });

  it("rejects cross-Vault snapshot envelopes before returning plaintext paths", async () => {
    rpc.mockResolvedValue({
      data: {
        vaultId: VAULT_ID,
        generation: 1,
        encryptedEnvelope: {
          ...snapshotEnvelope,
          vaultId: "423e4567-e89b-42d3-a456-426614174000",
        },
        ciphertextBytes: 1,
        updatedAt: TIMESTAMP,
      },
      error: null,
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.loadSnapshot({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
  });

  it("maps stable server errors without leaking capability or SDK details", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "VAULT_CAPABILITY_REVOKED" },
    });
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.resolveCapability({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_REVOKED" });

    const unknown = mapSupabaseVaultError({
      message: `database failed for capability ${CAPABILITY}`,
      details: { capability: CAPABILITY },
    });
    expect(unknown).toMatchObject({ code: "VAULT_INTERNAL" });
    expect(unknown.message).not.toContain(CAPABILITY);
  });

  it("rejects invalid inputs without invoking Supabase", async () => {
    const service = createSupabaseVaultPersistenceService(createReadyToken(), {
      client,
    });

    await expect(
      service.resolveCapability({
        vaultId: VAULT_ID,
        invitationCapability: "not-a-capability",
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
