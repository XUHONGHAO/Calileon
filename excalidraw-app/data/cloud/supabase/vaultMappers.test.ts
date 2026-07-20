import { describe, expect, it } from "vitest";

import {
  mapVaultAssetRegistrationResult,
  mapVaultCapabilityResolution,
} from "./vaultMappers";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("Vault Supabase response mappers", () => {
  it("maps timestamps to epoch milliseconds", () => {
    expect(
      mapVaultCapabilityResolution({
        vaultId: VAULT_ID,
        invitationId: "223e4567-e89b-42d3-a456-426614174000",
        role: "viewer",
        authorizationVersion: 1,
        activeRoomId: "vault_room_123456",
        snapshotGeneration: 2,
        expiresAt: "2026-07-14T08:00:00.000Z",
      }).expiresAt,
    ).toBe(Date.parse("2026-07-14T08:00:00.000Z"));
  });

  it.each([
    ["unknown role", { role: "owner" }],
    ["short room ID", { activeRoomId: "room" }],
    ["fractional generation", { snapshotGeneration: 1.5 }],
    ["extra field", { secret: "must-not-pass" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      mapVaultCapabilityResolution({
        vaultId: VAULT_ID,
        invitationId: "223e4567-e89b-42d3-a456-426614174000",
        role: "viewer",
        authorizationVersion: 1,
        activeRoomId: "vault_room_123456",
        snapshotGeneration: 2,
        expiresAt: null,
        ...override,
      }),
    ).toThrowError(expect.objectContaining({ code: "VAULT_INTERNAL" }));
  });

  it("rejects a server-provided storage path outside the frozen Vault scope", () => {
    expect(() =>
      mapVaultAssetRegistrationResult({
        vaultId: VAULT_ID,
        fileId: "asset_file_12345",
        storagePath: "ordinary-assets/asset_file_12345",
        state: "pending",
      }),
    ).toThrowError(expect.objectContaining({ code: "VAULT_INTERNAL" }));
  });
});
