import { describe, expect, it, vi } from "vitest";

import { createHttpVaultRoomProvisionTransport } from "./roomProvision";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174001";

describe("Vault room provision transport", () => {
  it("sends only public provisioning metadata", async () => {
    let capturedInit:
      | Parameters<
          NonNullable<
            Parameters<
              typeof createHttpVaultRoomProvisionTransport
            >[0]["fetcher"]
          >
        >[1]
      | null = null;
    const fetcher = vi.fn(async (_url, init) => {
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          protocolVersion: 1,
          activeRoomId: "vault_room_1234567890",
        }),
      };
    });
    const transport = createHttpVaultRoomProvisionTransport({
      provisionUrl: "https://room.example/vault/rooms",
      fetcher,
    });
    await expect(
      transport.provision({ vaultId, invitationId }),
    ).resolves.toEqual({
      kind: "vault-room",
      activeRoomId: "vault_room_1234567890",
    });
    expect(capturedInit).not.toBeNull();
    const init = capturedInit!;
    expect(JSON.parse(init.body)).toEqual({
      protocolVersion: 1,
      vaultId,
      invitationId,
    });
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.body).not.toContain("key");
    expect(init.body).not.toContain("capability");
  });

  it.each([
    "http://room.example/vault/rooms",
    "https://user:pass@room.example/vault/rooms",
    "https://room.example/vault/rooms#secret",
  ])("rejects unsafe provision URLs: %s", (provisionUrl) => {
    expect(() =>
      createHttpVaultRoomProvisionTransport({ provisionUrl }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("rejects extra or incompatible response fields", async () => {
    const transport = createHttpVaultRoomProvisionTransport({
      provisionUrl: "https://room.example/vault/rooms",
      fetcher: async () => ({
        ok: true,
        json: async () => ({
          protocolVersion: 1,
          activeRoomId: "vault_room_1234567890",
          roomKey: "forbidden",
        }),
      }),
    });
    await expect(
      transport.provision({ vaultId, invitationId }),
    ).rejects.toMatchObject({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" });
  });

  it("maps network and HTTP failures to a stable recoverable error", async () => {
    const transport = createHttpVaultRoomProvisionTransport({
      provisionUrl: "https://room.example/vault/rooms",
      fetcher: async () => {
        throw new Error("contains internal endpoint details");
      },
    });
    await expect(
      transport.provision({ vaultId, invitationId }),
    ).rejects.toMatchObject({
      code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      recoverable: true,
      message: "Vault room provisioning failed.",
    });
  });
});
