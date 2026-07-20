import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { createVault } from "./creation";
import { createVaultOwnerService } from "./owner";

const invitationId = "123e4567-e89b-42d3-a456-426614174001";

const deployment = assertVaultDeploymentReady(
  {
    enabled: true,
    protocolVersions: [1],
    roomProtocolVersions: [1],
    invitationService: true,
    encryptedSnapshotPersistence: true,
    encryptedAssetPersistence: true,
  },
  { isSecureContext: true, hasWebCrypto: true },
);

describe("Vault creation flow", () => {
  it("creates metadata, provisions a Vault room, activates, then returns an editor link", async () => {
    const calls: string[] = [];
    const owner = createVaultOwnerService(deployment, {
      create: async ({ vaultId, editorInvitationCapability }) => {
        calls.push("create");
        expect(editorInvitationCapability).toHaveLength(43);
        return {
          vaultId,
          state: "creating",
          invitationId,
          snapshotGeneration: 0,
        };
      },
      activate: async ({ vaultId, activeRoomId }) => {
        calls.push("activate");
        return { vaultId, state: "active", activeRoomId };
      },
      failCreation: async () => {
        calls.push("fail");
      },
      createInvitation: async () => {
        throw new Error("unused");
      },
      revokeInvitation: async () => {
        throw new Error("unused");
      },
      revokeVault: async () => {
        throw new Error("unused");
      },
      softDeleteVault: async () => {
        throw new Error("unused");
      },
    });
    const rooms = {
      provision: vi.fn(async () => {
        calls.push("room");
        return {
          kind: "vault-room" as const,
          activeRoomId: "vault_room_1234567890",
        };
      }),
    };
    const created = await createVault({
      deployment,
      owner,
      rooms,
      baseUrl: "https://app.example/board#room=legacy,key",
    });
    expect(calls).toEqual(["create", "room", "activate"]);
    expect(created.editorLink).toMatch(
      new RegExp(`^https://app\\.example/board#vault=1&id=${created.vaultId}`),
    );
    expect(created.editorLink).not.toContain("room=legacy");
  });

  it("marks creation failed when room provisioning fails and never returns a fallback link", async () => {
    const failCreation = vi.fn(async () => undefined);
    const owner = createVaultOwnerService(deployment, {
      create: async ({ vaultId }) => ({
        vaultId,
        state: "creating",
        invitationId,
        snapshotGeneration: 0,
      }),
      activate: async () => {
        throw new Error("must not activate");
      },
      failCreation,
      createInvitation: async () => {
        throw new Error("unused");
      },
      revokeInvitation: async () => {
        throw new Error("unused");
      },
      revokeVault: async () => {
        throw new Error("unused");
      },
      softDeleteVault: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      createVault({
        deployment,
        owner,
        rooms: {
          provision: async () => {
            throw new Error("room unavailable");
          },
        },
      }),
    ).rejects.toThrow("room unavailable");
    expect(failCreation).toHaveBeenCalledOnce();
  });
});
