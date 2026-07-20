import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "../vault/capabilities";

import {
  assertVaultBackend,
  createSupabaseVaultBackend,
  isVaultBackend,
} from "./vault";

import type { VaultDeploymentReady } from "../vault/capabilities";
import type { VaultBackend } from "./vault";

const createReady = () =>
  assertVaultDeploymentReady(
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

describe("dedicated Vault backend assembly", () => {
  it("assembles only dedicated Vault encrypted services", () => {
    const backend = createSupabaseVaultBackend(createReady(), {
      client: { rpc: vi.fn() },
    });

    expect(backend.kind).toBe("vault-backend");
    expect(backend.assets.kind).toBe("vault-encrypted-asset-service");
    expect(backend.owner.kind).toBe("vault-owner-service");
    expect(backend.persistence.kind).toBe("vault-persistence");
    expect("collabPersistence" in backend).toBe(false);
    expect("scenes" in backend).toBe(false);
    expect("firebase" in backend).toBe(false);
    expect(Object.isFrozen(backend)).toBe(true);
    expect(isVaultBackend(backend)).toBe(true);
    expect(() => assertVaultBackend(backend)).not.toThrow();
  });

  it("rejects a forged deployment proof before constructing adapters", () => {
    const rpc = vi.fn();
    const forged = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    } as unknown as VaultDeploymentReady;

    expect(() =>
      createSupabaseVaultBackend(forged, { client: { rpc } }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects forged backends and structurally forged services", () => {
    const forged = {
      kind: "vault-backend",
      deployment: createReady(),
      assets: { kind: "vault-encrypted-asset-service", protocolVersion: 1 },
      owner: { kind: "vault-owner-service", protocolVersion: 1 },
      persistence: { kind: "vault-persistence", protocolVersion: 1 },
    } as unknown as VaultBackend;

    expect(isVaultBackend(forged)).toBe(false);
    expect(() => assertVaultBackend(forged)).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });
});
