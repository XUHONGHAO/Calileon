import { describe, expect, it } from "vitest";

import {
  assertExactVaultAssetStoragePath,
  assertVaultAssetEnvelopeBytes,
  assertVaultAssetRegistration,
  parseVaultAssetAccessRequest,
  sha256Base64Url,
  toStableVaultAssetErrorCode,
  VAULT_ASSET_DOWNLOAD_TTL_SECONDS,
} from "./vaultAssetSecurity";

import type { VaultAssetSecurityError } from "./vaultAssetSecurity";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const FILE_ID = "assetfileid00001";
const CAPABILITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DIGEST = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const getCode = (callback: () => unknown) => {
  try {
    callback();
  } catch (error) {
    return (error as VaultAssetSecurityError).code;
  }
  throw new Error("expected Vault asset validation to fail");
};

describe("Vault asset Edge security", () => {
  it("limits signed downloads to a 60-second revoke residual window", () => {
    expect(VAULT_ASSET_DOWNLOAD_TTL_SECONDS).toBe(60);
  });

  it("accepts only the exact action-specific request fields", () => {
    expect(
      parseVaultAssetAccessRequest({
        action: "create-upload",
        vaultId: VAULT_ID.toUpperCase(),
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
        encryptedDigest: DIGEST,
        ciphertextBytes: 128,
      }),
    ).toEqual({
      action: "create-upload",
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
      fileId: FILE_ID,
      encryptedDigest: DIGEST,
      ciphertextBytes: 128,
    });
    expect(
      parseVaultAssetAccessRequest({
        action: "complete-upload",
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
      }).action,
    ).toBe("complete-upload");
    expect(
      getCode(() =>
        parseVaultAssetAccessRequest({
          action: "create-download",
          vaultId: VAULT_ID,
          invitationCapability: CAPABILITY,
          fileId: FILE_ID,
          filename: "plain-secret.png",
        }),
      ),
    ).toBe("VAULT_ENVELOPE_INVALID");
  });

  it("rejects malformed capabilities, IDs, digests, and sizes", () => {
    for (const override of [
      { invitationCapability: "secret" },
      { fileId: "../escape" },
      { encryptedDigest: "digest" },
      { ciphertextBytes: 0 },
      { ciphertextBytes: 100 * 1024 * 1024 + 1 },
    ]) {
      expect(
        getCode(() =>
          parseVaultAssetAccessRequest({
            action: "create-upload",
            vaultId: VAULT_ID,
            invitationCapability: CAPABILITY,
            fileId: FILE_ID,
            encryptedDigest: DIGEST,
            ciphertextBytes: 128,
            ...override,
          }),
        ),
      ).toMatch(/^VAULT_/);
    }
  });

  it("binds all storage operations to the exact opaque path", () => {
    const path = `vault/${VAULT_ID}/${FILE_ID}`;
    expect(assertExactVaultAssetStoragePath(path, VAULT_ID, FILE_ID)).toBe(
      path,
    );
    expect(
      getCode(() =>
        assertExactVaultAssetStoragePath(
          `vault/${VAULT_ID}/otherfileid00001`,
          VAULT_ID,
          FILE_ID,
        ),
      ),
    ).toBe("VAULT_INTERNAL");
    expect(
      getCode(() =>
        assertVaultAssetRegistration(
          {
            vaultId: VAULT_ID,
            fileId: FILE_ID,
            storagePath: `vault/${VAULT_ID}/otherfileid00001`,
            state: "pending",
          },
          VAULT_ID,
          FILE_ID,
        ),
      ),
    ).toBe("VAULT_INTERNAL");
  });

  it("accepts only strict asset envelope V1 bytes bound to the Vault", () => {
    const envelope = {
      version: 1,
      vaultId: VAULT_ID,
      purpose: "asset",
      messageType: "asset.content",
      messageId: "10000000-0000-4000-8000-000000000101",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AQ",
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    expect(assertVaultAssetEnvelopeBytes(bytes, VAULT_ID)).toEqual(envelope);

    for (const invalid of [
      { ...envelope, vaultId: "20000000-0000-4000-8000-000000000001" },
      { ...envelope, purpose: "snapshot" },
      { ...envelope, messageType: "snapshot.scene" },
      { ...envelope, generation: 1 },
      { ...envelope, iv: "not-canonical" },
    ]) {
      expect(
        getCode(() =>
          assertVaultAssetEnvelopeBytes(
            new TextEncoder().encode(JSON.stringify(invalid)),
            VAULT_ID,
          ),
        ),
      ).toMatch(/^VAULT_/);
    }
  });

  it("requires byte-exact canonical asset envelope serialization", () => {
    const canonical =
      '{"version":1,"vaultId":"10000000-0000-4000-8000-000000000001","purpose":"asset","messageType":"asset.content","messageId":"10000000-0000-4000-8000-000000000101","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AQ"}';
    expect(() =>
      assertVaultAssetEnvelopeBytes(
        new TextEncoder().encode(canonical),
        VAULT_ID,
      ),
    ).not.toThrow();

    const nonCanonical = [
      `${canonical}\n`,
      canonical.replace('{"version":1,', '{ "version": 1, '),
      canonical.replace(
        '{"version":1,"vaultId":"10000000-0000-4000-8000-000000000001"',
        '{"vaultId":"10000000-0000-4000-8000-000000000001","version":1',
      ),
      canonical.replace('"purpose":"asset"', '"purpose":"\\u0061sset"'),
    ];
    for (const serialized of nonCanonical) {
      expect(
        getCode(() =>
          assertVaultAssetEnvelopeBytes(
            new TextEncoder().encode(serialized),
            VAULT_ID,
          ),
        ),
      ).toBe("VAULT_ENVELOPE_INVALID");
    }
  });

  it("hashes exact uploaded bytes using SHA-256 base64url", async () => {
    expect(await sha256Base64Url(new TextEncoder().encode("vault"))).toBe(
      "5vCh-7Q8iRltz8vvhZCPGatMX3zE9MRSKEaXdXaD1-8",
    );
  });

  it("maps only allowlisted backend errors and hides raw SDK details", () => {
    expect(
      toStableVaultAssetErrorCode({
        code: "P0001",
        message: "VAULT_CAPABILITY_REVOKED",
        details: CAPABILITY,
      }),
    ).toBe("VAULT_CAPABILITY_REVOKED");
    expect(
      toStableVaultAssetErrorCode(
        new Error(`download failed ${CAPABILITY} vault/${VAULT_ID}/${FILE_ID}`),
      ),
    ).toBe("VAULT_INTERNAL");
  });
});
