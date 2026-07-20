import { describe, expect, it } from "vitest";

import { issueVaultAdmission } from "./admission";
import { assertVaultDeploymentReady } from "./capabilities";
import { createVaultPersistenceService } from "./persistence";
import {
  isVaultClientSession,
  openVaultClientSession,
  readVaultSessionSecrets,
} from "./session";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174001";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174002";
const rootKey = "A".repeat(43);
const invitationCapability = "B".repeat(43);

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

const resolution = {
  vaultId,
  invitationId,
  role: "editor" as const,
  authorizationVersion: 1,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration: 0,
  expiresAt: null,
};

describe("Vault client session", () => {
  it("resolves capability before issuing an in-memory session", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution,
      loadSnapshot: async () => null,
      casSnapshot: async () => ({ vaultId, generation: 1, updatedAt: 1 }),
      registerAsset: async () => {
        throw new Error("unused");
      },
      resolveAsset: async () => {
        throw new Error("unused");
      },
    });
    const session = await openVaultClientSession({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
    });
    expect(isVaultClientSession(session)).toBe(true);
    expect(session.admission).toEqual(
      issueVaultAdmission(deployment, resolution, senderSessionId),
    );
    expect(session.role).toBe("editor");
  });

  it("keeps the root key and capability out of enumerable session state", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution,
      loadSnapshot: async () => null,
      casSnapshot: async () => ({ vaultId, generation: 1, updatedAt: 1 }),
      registerAsset: async () => {
        throw new Error("unused");
      },
      resolveAsset: async () => {
        throw new Error("unused");
      },
    });
    const session = await openVaultClientSession({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
    });
    expect(JSON.stringify(session)).not.toContain(rootKey);
    expect(JSON.stringify(session)).not.toContain(invitationCapability);
    expect(readVaultSessionSecrets(session)).toEqual({
      rootKey,
      invitationCapability,
    });
  });

  it("rejects a capability resolution for another Vault", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => ({
        ...resolution,
        vaultId: "123e4567-e89b-42d3-a456-426614174099",
      }),
      loadSnapshot: async () => null,
      casSnapshot: async () => ({ vaultId, generation: 1, updatedAt: 1 }),
      registerAsset: async () => {
        throw new Error("unused");
      },
      resolveAsset: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      openVaultClientSession({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_INVALID" });
  });
});
