import { describe, expect, it } from "vitest";

import {
  assertVaultDeploymentReady,
  assertVaultDeploymentReadyToken,
  assertVaultPersistenceTarget,
  isVaultDeploymentReady,
} from "./capabilities";

import type { VaultDeploymentCapabilities } from "./types";

const ready: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

describe("Vault fail-closed capability preflight", () => {
  it("accepts only a complete secure deployment", () => {
    const token = assertVaultDeploymentReady(ready, {
      isSecureContext: true,
      hasWebCrypto: true,
    });

    expect(token).toMatchObject({
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    });
    expect(Object.isFrozen(token)).toBe(true);
    expect(isVaultDeploymentReady(token)).toBe(true);
    expect(() => assertVaultDeploymentReadyToken(token)).not.toThrow();
  });

  it("rejects forged deployment-ready tokens at runtime", () => {
    const forged = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    };

    expect(isVaultDeploymentReady(forged)).toBe(false);
    expect(() => assertVaultDeploymentReadyToken(forged)).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });

  it.each([
    [{ ...ready, enabled: false }, "VAULT_PERSISTENCE_UNAVAILABLE"],
    [{ ...ready, protocolVersions: [] }, "VAULT_PROTOCOL_UNSUPPORTED"],
    [{ ...ready, roomProtocolVersions: [] }, "VAULT_ROOM_PROTOCOL_UNSUPPORTED"],
    [{ ...ready, invitationService: false }, "VAULT_PERSISTENCE_UNAVAILABLE"],
    [
      { ...ready, encryptedSnapshotPersistence: false },
      "VAULT_PERSISTENCE_UNAVAILABLE",
    ],
    [
      { ...ready, encryptedAssetPersistence: false },
      "VAULT_PERSISTENCE_UNAVAILABLE",
    ],
  ] as const)("fails closed for an incomplete capability set", (caps, code) => {
    expect(() =>
      assertVaultDeploymentReady(caps, {
        isSecureContext: true,
        hasWebCrypto: true,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects insecure contexts before checking backend fallback", () => {
    expect(() =>
      assertVaultDeploymentReady(ready, {
        isSecureContext: false,
        hasWebCrypto: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_SECURE_CONTEXT_REQUIRED" }),
    );
  });

  it("forbids plain and legacy persistence targets", () => {
    expect(() => assertVaultPersistenceTarget("vault")).not.toThrow();
    expect(() => assertVaultPersistenceTarget("plain")).toThrowError(
      expect.objectContaining({ code: "VAULT_PLAIN_FALLBACK_FORBIDDEN" }),
    );
    expect(() => assertVaultPersistenceTarget("legacy")).toThrowError(
      expect.objectContaining({ code: "VAULT_PLAIN_FALLBACK_FORBIDDEN" }),
    );
  });
});
