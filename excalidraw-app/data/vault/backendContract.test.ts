import { describe, expect, it } from "vitest";

import { VAULT_RPC, VAULT_SOCKET_EVENTS } from "./backendContract";
import { VAULT_ERROR_CODES } from "./errors";

import type { VaultSocketBroadcast } from "./backendContract";

describe("Vault backend contract", () => {
  it("freezes separate Vault RPC names", () => {
    expect(VAULT_RPC).toEqual({
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
    });
  });

  it("freezes the socket revoke/expire control plane", () => {
    expect(VAULT_SOCKET_EVENTS).toEqual({
      join: "vault:join",
      server: "vault:server",
      serverVolatile: "vault:server-volatile",
      capabilityRevoked: "vault:capability-revoked",
      capabilityExpired: "vault:capability-expired",
    });
  });

  it("binds each server broadcast to admission-confirmed transport metadata", () => {
    const broadcast: VaultSocketBroadcast = {
      sourceSocketId: "socket-1",
      admittedSenderSessionId: "123e4567-e89b-42d3-a456-426614174001",
      envelope: {
        version: 1,
        vaultId: "123e4567-e89b-42d3-a456-426614174000",
        purpose: "realtime",
        messageType: "realtime.presence",
        messageId: "123e4567-e89b-42d3-a456-426614174003",
        senderSessionId: "123e4567-e89b-42d3-a456-426614174001",
        sequence: 1,
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    };

    expect(broadcast.admittedSenderSessionId).toBe(
      broadcast.envelope.senderSessionId,
    );
  });

  it("keeps the stable error code registry unique", () => {
    expect(new Set(VAULT_ERROR_CODES).size).toBe(VAULT_ERROR_CODES.length);
    expect(VAULT_ERROR_CODES).toContain("VAULT_PLAIN_FALLBACK_FORBIDDEN");
    expect(VAULT_ERROR_CODES).toContain("VAULT_SNAPSHOT_CONFLICT");
    expect(VAULT_ERROR_CODES).toContain("VAULT_CAPABILITY_REVOKED");
  });
});
