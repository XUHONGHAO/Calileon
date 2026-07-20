import { describe, expect, it, vi } from "vitest";

import {
  createHttpVaultDeploymentDiscoveryTransport,
  discoverVaultDeployment,
  parseVaultPersistenceCapabilities,
  parseVaultRoomCapabilities,
} from "./deploymentDiscovery";

const persistence = {
  deploymentVersion: "p4a-f4-v1",
  schemaVersion: 1,
  enabled: true,
  protocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};
const room = {
  deploymentVersion: "p4a-f4-v1",
  roomServerVersion: 1,
  protocolVersions: [1],
};

describe("Vault deployment capability discovery", () => {
  it("combines strict persistence and room documents into a ready proof", async () => {
    const result = await discoverVaultDeployment(
      {
        loadPersistenceCapabilities: vi.fn().mockResolvedValue(persistence),
        loadRoomCapabilities: vi.fn().mockResolvedValue(room),
      },
      { isSecureContext: true, hasWebCrypto: true },
    );

    expect(result.capabilities).toEqual({
      enabled: true,
      protocolVersions: [1],
      roomProtocolVersions: [1],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    });
    expect(result.ready).toMatchObject({
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    });
  });

  it("rejects extra or malformed persistence capability fields", () => {
    expect(() =>
      parseVaultPersistenceCapabilities({ ...persistence, legacy: true }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(() =>
      parseVaultPersistenceCapabilities({
        ...persistence,
        protocolVersions: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });

  it("rejects malformed room capability documents independently", () => {
    expect(() =>
      parseVaultRoomCapabilities({ protocolVersions: [1], roomId: "legacy" }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("fails closed when the App, room, or schema deployment version differs", async () => {
    await expect(
      discoverVaultDeployment(
        {
          loadPersistenceCapabilities: vi
            .fn()
            .mockResolvedValue({ ...persistence, schemaVersion: 2 }),
          loadRoomCapabilities: vi.fn().mockResolvedValue(room),
        },
        { isSecureContext: true, hasWebCrypto: true },
      ),
    ).rejects.toMatchObject({ code: "VAULT_PROTOCOL_UNSUPPORTED" });

    await expect(
      discoverVaultDeployment(
        {
          loadPersistenceCapabilities: vi.fn().mockResolvedValue(persistence),
          loadRoomCapabilities: vi
            .fn()
            .mockResolvedValue({ ...room, roomServerVersion: 2 }),
        },
        { isSecureContext: true, hasWebCrypto: true },
      ),
    ).rejects.toMatchObject({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" });
  });

  it("maps raw discovery failures without exposing the source error", async () => {
    const sentinel = "P4-PLAINTEXT-SENTINEL-20260713";
    await expect(
      discoverVaultDeployment(
        {
          loadPersistenceCapabilities: vi
            .fn()
            .mockRejectedValue(new Error(sentinel)),
          loadRoomCapabilities: vi.fn().mockResolvedValue(room),
        },
        { isSecureContext: true, hasWebCrypto: true },
      ),
    ).rejects.toMatchObject({
      code: "VAULT_PERSISTENCE_UNAVAILABLE",
      message: "Vault capability discovery failed.",
    });
  });

  it("fails closed when the room protocol is unavailable", async () => {
    await expect(
      discoverVaultDeployment(
        {
          loadPersistenceCapabilities: vi.fn().mockResolvedValue(persistence),
          loadRoomCapabilities: vi.fn().mockRejectedValue(new Error("raw")),
        },
        { isSecureContext: true, hasWebCrypto: true },
      ),
    ).rejects.toMatchObject({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" });
  });

  it("loads public capability documents without credentials or URL fragments", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => persistence })
      .mockResolvedValueOnce({ ok: true, json: async () => room });
    const transport = createHttpVaultDeploymentDiscoveryTransport({
      persistenceCapabilitiesUrl:
        "https://vault.example/.well-known/vault-capabilities",
      roomCapabilitiesUrl:
        "https://room.example/.well-known/vault-capabilities",
      fetcher,
    });

    await transport.loadPersistenceCapabilities();
    await transport.loadRoomCapabilities();

    expect(fetcher.mock.calls).toEqual([
      [
        "https://vault.example/.well-known/vault-capabilities",
        {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      ],
      [
        "https://room.example/.well-known/vault-capabilities",
        {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      ],
    ]);
  });

  it("rejects insecure, credentialed, or fragment-bearing discovery URLs", () => {
    for (const url of [
      "http://vault.example/capabilities",
      "https://user:pass@vault.example/capabilities",
      "https://vault.example/capabilities#secret",
    ]) {
      expect(() =>
        createHttpVaultDeploymentDiscoveryTransport({
          persistenceCapabilitiesUrl: url,
          roomCapabilitiesUrl: "https://room.example/capabilities",
          fetcher: vi.fn(),
        }),
      ).toThrowError(
        expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
      );
    }
  });
});
