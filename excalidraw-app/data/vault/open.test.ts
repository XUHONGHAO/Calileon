import { describe, expect, it } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { encryptVaultSnapshot } from "./snapshot";
import { createVaultPersistenceService } from "./persistence";
import { openVault } from "./open";
import { base64UrlToBytes } from "./encoding";

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

const resolution = (snapshotGeneration: number) => ({
  vaultId,
  invitationId,
  role: "editor" as const,
  authorizationVersion: 1,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration,
  expiresAt: null,
});

const unused = async () => {
  throw new Error("unused");
};

describe("Vault open flow", () => {
  it("opens generation zero as a blank Vault without reading local state", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(0),
      loadSnapshot: async () => null,
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    const opened = await openVault({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
      createEmptySnapshot: () => ({ elements: [], files: {} }),
    });
    expect(opened).toMatchObject({
      generation: 0,
      isEmpty: true,
      syncStatus: "synced",
      snapshot: { elements: [], files: {} },
    });
  });

  it("decrypts a snapshot only when resolution and record generations match", async () => {
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 2,
      snapshot: { elements: [{ id: "secret-element" }], files: {} },
    });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(2),
      loadSnapshot: async () => ({
        vaultId,
        generation: 2,
        encryptedEnvelope: envelope,
        ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
        updatedAt: 10,
      }),
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).resolves.toMatchObject({
      generation: 2,
      isEmpty: false,
      snapshot: { elements: [{ id: "secret-element" }], files: {} },
    });
  });

  it("fails closed when metadata claims a snapshot but persistence returns none", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(1),
      loadSnapshot: async () => null,
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
  });

  it("fails closed on a generation race instead of accepting stale plaintext", async () => {
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { elements: [], files: {} },
    });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(2),
      loadSnapshot: async () => ({
        vaultId,
        generation: 1,
        encryptedEnvelope: envelope,
        ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
        updatedAt: 10,
      }),
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).rejects.toMatchObject({
      code: "VAULT_SNAPSHOT_CONFLICT",
      recoverable: true,
    });
  });
});
