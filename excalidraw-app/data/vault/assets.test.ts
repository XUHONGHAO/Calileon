import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import {
  assertVaultEncryptedAssetService,
  createVaultEncryptedAssetService,
  isVaultEncryptedAssetService,
} from "./assets";

describe("Vault encrypted asset service contract", () => {
  it("issues only a dedicated non-AssetStorage service after preflight", () => {
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
    const service = createVaultEncryptedAssetService(deployment, {
      upload: vi.fn(),
      download: vi.fn(),
    });

    expect(isVaultEncryptedAssetService(service)).toBe(true);
    expect(() => assertVaultEncryptedAssetService(service)).not.toThrow();
    expect(Object.keys(service).sort()).toEqual(
      ["download", "kind", "protocolVersion", "upload"].sort(),
    );
    expect("getUrl" in service).toBe(false);
    expect("listByScene" in service).toBe(false);
    expect("local" in service).toBe(false);
    expect("fallback" in service).toBe(false);
  });
});
