import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "../../vault/capabilities";
import { bytesToBase64Url } from "../../vault/encoding";

import {
  createSupabaseVaultEncryptedAssetService,
  serializeVaultAssetEnvelope,
} from "./SupabaseVaultEncryptedAssetService";

import type { VaultDeploymentCapabilities } from "../../vault/types";
import type {
  SupabaseVaultAssetClient,
  VaultAssetFetcher,
} from "./SupabaseVaultEncryptedAssetService";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_VAULT_ID = "223e4567-e89b-42d3-a456-426614174000";
const CAPABILITY = "A".repeat(43);
const FILE_ID = "asset_file_12345";
const STORAGE_PATH = `vault/${VAULT_ID}/${FILE_ID}`;

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

const envelope = {
  version: 1 as const,
  vaultId: VAULT_ID,
  purpose: "asset" as const,
  messageType: "asset.content" as const,
  messageId: "323e4567-e89b-42d3-a456-426614174000",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AQ",
};

const invoke = vi.fn();
const uploadToSignedUrl = vi.fn();
const storageFrom = vi.fn(() => ({ uploadToSignedUrl }));
const client: SupabaseVaultAssetClient = {
  functions: { invoke },
  storage: { from: storageFrom },
};

const toArrayBuffer = (bytes: Uint8Array<ArrayBuffer>): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );

describe("SupabaseVaultEncryptedAssetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadToSignedUrl.mockResolvedValue({ data: null, error: null });
  });

  it("strictly serializes, hashes, uploads, and completes an encrypted asset", async () => {
    const bytes = serializeVaultAssetEnvelope(envelope);
    const encryptedDigest = await digest(bytes);
    invoke
      .mockResolvedValueOnce({
        data: {
          storagePath: STORAGE_PATH,
          token: "signed-upload-token",
          state: "pending",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { vaultId: VAULT_ID, fileId: FILE_ID, state: "ready" },
        error: null,
      });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
    });

    await expect(
      service.upload({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
        envelope,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      fileId: FILE_ID,
      encryptedDigest,
      ciphertextBytes: bytes.byteLength,
    });

    expect(invoke.mock.calls).toEqual([
      [
        "vault-asset-access",
        {
          body: {
            action: "create-upload",
            vaultId: VAULT_ID,
            invitationCapability: CAPABILITY,
            fileId: FILE_ID,
            encryptedDigest,
            ciphertextBytes: bytes.byteLength,
          },
        },
      ],
      [
        "vault-asset-access",
        {
          body: {
            action: "complete-upload",
            vaultId: VAULT_ID,
            invitationCapability: CAPABILITY,
            fileId: FILE_ID,
          },
        },
      ],
    ]);
    expect(storageFrom).toHaveBeenCalledWith("vault-assets");
    expect(uploadToSignedUrl.mock.calls[0][0]).toBe(STORAGE_PATH);
    expect(uploadToSignedUrl.mock.calls[0][1]).toBe("signed-upload-token");
    expect(uploadToSignedUrl.mock.calls[0][2]).toEqual(bytes);
    expect(uploadToSignedUrl.mock.calls[0][3]).toEqual({ upsert: false });
  });

  it("returns an idempotent ready registration without overwriting storage", async () => {
    invoke.mockResolvedValue({
      data: { storagePath: STORAGE_PATH, token: null, state: "ready" },
      error: null,
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
    });

    await service.upload({
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
      fileId: FILE_ID,
      envelope,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("downloads and verifies exact bytes, digest, canonical envelope, and Vault binding", async () => {
    const bytes = serializeVaultAssetEnvelope(envelope);
    const encryptedDigest = await digest(bytes);
    invoke.mockResolvedValue({
      data: {
        url: "https://signed.example/vault-asset?token=secret",
        expiresAt: Date.parse("2099-07-14T08:00:00.000Z"),
        encryptedDigest,
        ciphertextBytes: bytes.byteLength,
      },
      error: null,
    });
    const fetcher = vi.fn<VaultAssetFetcher>().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => toArrayBuffer(bytes),
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
      fetcher,
    });

    await expect(
      service.download({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
      }),
    ).resolves.toEqual({
      vaultId: VAULT_ID,
      fileId: FILE_ID,
      encryptedDigest,
      ciphertextBytes: bytes.byteLength,
      envelope,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://signed.example/vault-asset?token=secret",
    );
  });

  it("rejects downloaded bytes whose digest differs from metadata", async () => {
    const bytes = serializeVaultAssetEnvelope(envelope);
    const encryptedDigest = await digest(bytes);
    const tampered = new Uint8Array(bytes);
    tampered[tampered.byteLength - 1] ^= 1;
    invoke.mockResolvedValue({
      data: {
        url: "https://signed.example/vault-asset",
        expiresAt: Date.parse("2099-07-14T08:00:00.000Z"),
        encryptedDigest,
        ciphertextBytes: tampered.byteLength,
      },
      error: null,
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
      fetcher: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => toArrayBuffer(tampered),
      }),
    });

    await expect(
      service.download({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ASSET_CONFLICT" });
  });

  it("rejects non-canonical or cross-Vault downloaded envelopes", async () => {
    const crossVaultBytes = serializeVaultAssetEnvelope({
      ...envelope,
      vaultId: OTHER_VAULT_ID,
    });
    const encryptedDigest = await digest(crossVaultBytes);
    invoke.mockResolvedValue({
      data: {
        url: "https://signed.example/vault-asset",
        expiresAt: Date.parse("2099-07-14T08:00:00.000Z"),
        encryptedDigest,
        ciphertextBytes: crossVaultBytes.byteLength,
      },
      error: null,
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
      fetcher: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => toArrayBuffer(crossVaultBytes),
      }),
    });

    await expect(
      service.download({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
  });

  it("rejects non-canonical JSON even when its digest and size match", async () => {
    const nonCanonicalBytes = new TextEncoder().encode(
      JSON.stringify(envelope, null, 2),
    );
    const encryptedDigest = await digest(nonCanonicalBytes);
    invoke.mockResolvedValue({
      data: {
        url: "https://signed.example/vault-asset",
        expiresAt: Date.parse("2099-07-14T08:00:00.000Z"),
        encryptedDigest,
        ciphertextBytes: nonCanonicalBytes.byteLength,
      },
      error: null,
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
      fetcher: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => toArrayBuffer(nonCanonicalBytes),
      }),
    });

    await expect(
      service.download({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
  });

  it("strictly rejects extra access response fields", async () => {
    invoke.mockResolvedValue({
      data: {
        storagePath: STORAGE_PATH,
        token: "signed-upload-token",
        state: "pending",
        fallbackUrl: "https://ordinary.example/asset",
      },
      error: null,
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
    });

    await expect(
      service.upload({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
        envelope,
      }),
    ).rejects.toMatchObject({ code: "VAULT_INTERNAL" });
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("maps only the stable Edge Function JSON error field", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: `request failed for ${CAPABILITY}`,
        context: {
          json: async () => ({ error: "VAULT_CAPABILITY_REVOKED" }),
        },
      },
    });
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
    });

    const promise = service.download({
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
      fileId: FILE_ID,
    });
    await expect(promise).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_REVOKED",
    });
    await promise.catch((error) =>
      expect((error as Error).message).not.toContain(CAPABILITY),
    );
  });

  it("rejects cross-Vault upload envelopes before external calls", async () => {
    const service = createSupabaseVaultEncryptedAssetService(deployment(), {
      client,
    });

    await expect(
      service.upload({
        vaultId: VAULT_ID,
        invitationCapability: CAPABILITY,
        fileId: FILE_ID,
        envelope: { ...envelope, vaultId: OTHER_VAULT_ID },
      }),
    ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
    expect(invoke).not.toHaveBeenCalled();
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });
});
