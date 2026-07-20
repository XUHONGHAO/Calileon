import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { VaultError } from "./errors";
import {
  createVaultOwnerService,
  type VaultOwnerServiceImplementation,
} from "./owner";
import {
  createVaultShareInvitation,
  revokeVaultShareInvitation,
} from "./sharing";
import { getVaultLinkData } from "./url";

import type { VaultDeploymentCapabilities } from "./types";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const ROOT_KEY = "A".repeat(43);
const EXPIRES_AT = Date.parse("2099-07-15T08:00:00.000Z");

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
  create: vi.fn(),
  activate: vi.fn(),
  failCreation: vi.fn(),
  createInvitation: vi.fn().mockResolvedValue({
    vaultId: VAULT_ID,
    invitationId: INVITATION_ID,
    role: "viewer",
    authorizationVersion: 1,
    expiresAt: EXPIRES_AT,
  }),
  revokeInvitation: vi.fn().mockResolvedValue({
    vaultId: VAULT_ID,
    invitationId: INVITATION_ID,
    authorizationVersion: 2,
    reason: "revoked",
  }),
  revokeVault: vi.fn(),
  softDeleteVault: vi.fn(),
});

describe("Vault sharing orchestration", () => {
  it("creates a viewer bearer link and returns only secret-free metadata", async () => {
    const implementation = createImplementation();
    const owner = createVaultOwnerService(deployment(), implementation);

    const result = await createVaultShareInvitation({
      owner,
      vaultId: VAULT_ID,
      rootKey: ROOT_KEY,
      role: "viewer",
      expiresAt: EXPIRES_AT,
      baseUrl: "https://vault.example/board#room=legacy,key",
    });

    const link = getVaultLinkData(result.link);
    expect(link).toMatchObject({
      vaultId: VAULT_ID,
      rootKey: ROOT_KEY,
    });
    expect(link?.invitationCapability).toHaveLength(43);
    expect(implementation.createInvitation).toHaveBeenCalledWith({
      vaultId: VAULT_ID,
      role: "viewer",
      invitationCapability: link?.invitationCapability,
      expiresAt: EXPIRES_AT,
    });
    expect(result.metadata).toEqual({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      role: "viewer",
      authorizationVersion: 1,
      expiresAt: EXPIRES_AT,
    });
    expect(Object.keys(result.metadata).sort()).toEqual(
      [
        "authorizationVersion",
        "expiresAt",
        "invitationId",
        "role",
        "vaultId",
      ].sort(),
    );
    expect(JSON.stringify(result.metadata)).not.toContain(ROOT_KEY);
    expect(JSON.stringify(result.metadata)).not.toContain(
      link?.invitationCapability,
    );
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });

  it("supports editor invitations without exposing a normal share surface", async () => {
    const implementation = createImplementation();
    vi.mocked(implementation.createInvitation).mockResolvedValue({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      role: "editor",
      authorizationVersion: 1,
      expiresAt: null,
    });
    const owner = createVaultOwnerService(deployment(), implementation);

    const result = await createVaultShareInvitation({
      owner,
      vaultId: VAULT_ID,
      rootKey: ROOT_KEY,
      role: "editor",
      expiresAt: null,
      baseUrl: "https://vault.example/board",
    });

    expect(result.metadata.role).toBe("editor");
    expect(Object.keys(implementation)).not.toContain("shareScene");
  });

  it("fails before owner persistence when the root key is invalid", async () => {
    const implementation = createImplementation();
    const owner = createVaultOwnerService(deployment(), implementation);

    await expect(
      createVaultShareInvitation({
        owner,
        vaultId: VAULT_ID,
        rootKey: "not-a-root-key",
        role: "viewer",
        expiresAt: EXPIRES_AT,
        baseUrl: "https://vault.example/board",
      }),
    ).rejects.toMatchObject({ code: "VAULT_URL_INVALID" });
    expect(implementation.createInvitation).not.toHaveBeenCalled();
  });

  it("rejects unexpected owner responses instead of returning a share link", async () => {
    const implementation = createImplementation();
    vi.mocked(implementation.createInvitation).mockResolvedValue({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      role: "viewer",
      authorizationVersion: 1,
      expiresAt: EXPIRES_AT,
      plainShareId: "legacy-share",
    } as never);
    const owner = createVaultOwnerService(deployment(), implementation);

    await expect(
      createVaultShareInvitation({
        owner,
        vaultId: VAULT_ID,
        rootKey: ROOT_KEY,
        role: "viewer",
        expiresAt: EXPIRES_AT,
        baseUrl: "https://vault.example/board",
      }),
    ).rejects.toMatchObject({ code: "VAULT_INTERNAL" });
  });

  it("redacts owner failures while preserving stable Vault error codes", async () => {
    const implementation = createImplementation();
    let issuedCapability = "";
    vi.mocked(implementation.createInvitation).mockImplementation(
      async (input) => {
        issuedCapability = input.invitationCapability;
        throw new VaultError(
          "VAULT_CAPABILITY_FORBIDDEN",
          `owner leaked ${ROOT_KEY} ${issuedCapability}`,
        );
      },
    );
    const owner = createVaultOwnerService(deployment(), implementation);

    const promise = createVaultShareInvitation({
      owner,
      vaultId: VAULT_ID,
      rootKey: ROOT_KEY,
      role: "viewer",
      expiresAt: EXPIRES_AT,
      baseUrl: "https://vault.example/board",
    });
    await expect(promise).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_FORBIDDEN",
      message: "Vault invitation creation failed.",
    });
    await promise.catch((error) => {
      expect((error as Error).message).not.toContain(ROOT_KEY);
      expect((error as Error).message).not.toContain(issuedCapability);
    });
  });

  it("returns a stable, secret-free revocation record on repeated revoke", async () => {
    const implementation = createImplementation();
    const owner = createVaultOwnerService(deployment(), implementation);

    const first = await revokeVaultShareInvitation({
      owner,
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
    });
    const second = await revokeVaultShareInvitation({
      owner,
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
    });

    expect(first).toEqual({
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      authorizationVersion: 2,
      reason: "revoked",
    });
    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(
      ["authorizationVersion", "invitationId", "reason", "vaultId"].sort(),
    );
    expect(implementation.revokeInvitation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain(ROOT_KEY);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects forged owner services without invoking another share path", async () => {
    const forgedOwner = {
      kind: "vault-owner-service",
      protocolVersion: 1,
      createInvitation: vi.fn(),
      shareScene: vi.fn(),
    };

    await expect(
      createVaultShareInvitation({
        owner: forgedOwner as never,
        vaultId: VAULT_ID,
        rootKey: ROOT_KEY,
        role: "viewer",
        expiresAt: EXPIRES_AT,
        baseUrl: "https://vault.example/board",
      }),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
    expect(forgedOwner.createInvitation).not.toHaveBeenCalled();
    expect(forgedOwner.shareScene).not.toHaveBeenCalled();
  });
});
