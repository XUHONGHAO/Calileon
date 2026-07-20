import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { base64UrlToBytes } from "./encoding";
import { VaultError } from "./errors";
import { createVaultPersistenceService } from "./persistence";
import {
  decryptVaultSnapshot,
  encryptVaultSnapshot,
  loadVaultSnapshot,
  saveVaultSnapshot,
} from "./snapshot";

import type { VaultPersistenceServiceImplementation } from "./persistence";
import type {
  VaultDeploymentCapabilities,
  VaultSnapshotEncryptedEnvelopeV1,
} from "./types";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const otherVaultId = "123e4567-e89b-42d3-a456-426614174999";
const invitationCapability = `${"C".repeat(42)}A`;
const capabilities: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

const createPersistence = (
  overrides: Partial<VaultPersistenceServiceImplementation> = {},
) =>
  createVaultPersistenceService(
    assertVaultDeploymentReady(capabilities, {
      isSecureContext: true,
      hasWebCrypto: true,
    }),
    {
      resolveCapability: vi.fn(),
      loadSnapshot: vi.fn(),
      casSnapshot: vi.fn(),
      registerAsset: vi.fn(),
      resolveAsset: vi.fn(),
      ...overrides,
    },
  );

describe("Vault snapshot encryption", () => {
  it("serializes JSON into a snapshot-purpose envelope", async () => {
    const rootKey = generateVaultRootKey();
    const snapshot = { elements: [{ id: "secret-element" }] };
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 3,
      snapshot,
    });

    expect(envelope).toMatchObject({
      version: 1,
      vaultId,
      purpose: "snapshot",
      messageType: "snapshot.scene",
      generation: 3,
    });
    expect(JSON.stringify(envelope)).not.toContain("secret-element");
    await expect(
      decryptVaultSnapshot({ vaultId, rootKey, generation: 3, envelope }),
    ).resolves.toEqual(snapshot);
  });

  it("maps non-JSON input to a stable error", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      encryptVaultSnapshot({
        vaultId,
        rootKey: generateVaultRootKey(),
        generation: 1,
        snapshot: cyclic,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
  });
});

describe("Vault snapshot load", () => {
  it("loads and decrypts a Vault/generation-bound envelope", async () => {
    const rootKey = generateVaultRootKey();
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 4,
      snapshot: { marker: "vault-only" },
    });
    const persistence = createPersistence({
      loadSnapshot: vi.fn().mockResolvedValue({
        vaultId,
        generation: 4,
        encryptedEnvelope: envelope,
        ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
        updatedAt: 1234,
      }),
    });

    await expect(
      loadVaultSnapshot<{ marker: string }>({
        persistence,
        vaultId,
        invitationCapability,
        rootKey,
      }),
    ).resolves.toEqual({
      snapshot: { marker: "vault-only" },
      generation: 4,
      updatedAt: 1234,
    });
  });

  it.each([
    ["record Vault", otherVaultId, vaultId, 4],
    ["envelope Vault", vaultId, otherVaultId, 4],
    ["generation", vaultId, vaultId, 5],
  ])(
    "rejects mismatched %s binding before decrypting",
    async (_name, recordVaultId, envelopeVaultId, envelopeGeneration) => {
      const rootKey = generateVaultRootKey();
      const envelope = await encryptVaultSnapshot({
        vaultId,
        rootKey,
        generation: 4,
        snapshot: { marker: "vault-only" },
      });
      const persistence = createPersistence({
        loadSnapshot: vi.fn().mockResolvedValue({
          vaultId: recordVaultId,
          generation: 4,
          encryptedEnvelope: {
            ...envelope,
            vaultId: envelopeVaultId,
            generation: envelopeGeneration,
          } as VaultSnapshotEncryptedEnvelopeV1,
          ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
          updatedAt: 1234,
        }),
      });

      await expect(
        loadVaultSnapshot({
          persistence,
          vaultId,
          invitationCapability,
          rootKey,
        }),
      ).rejects.toMatchObject({ code: "VAULT_ENVELOPE_INVALID" });
    },
  );
});

describe("Vault snapshot CAS", () => {
  it("allows editor CAS at expected generation + 1", async () => {
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      generation: 8,
      updatedAt: 5678,
    });
    const snapshot = { elements: [{ id: "local" }] };
    const result = await saveVaultSnapshot({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey: generateVaultRootKey(),
      role: "editor",
      expectedGeneration: 7,
      snapshot,
    });

    expect(result).toEqual({
      status: "synced",
      snapshot,
      generation: 8,
      updatedAt: 5678,
    });
    expect(casSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 7,
        envelope: expect.objectContaining({
          purpose: "snapshot",
          messageType: "snapshot.scene",
          generation: 8,
        }),
        ciphertextBytes: expect.any(Number),
      }),
    );
  });

  it("rejects viewer writes before encryption or persistence", async () => {
    const casSnapshot = vi.fn();
    await expect(
      saveVaultSnapshot({
        persistence: createPersistence({ casSnapshot }),
        vaultId,
        invitationCapability,
        rootKey: "not-even-read",
        role: "viewer",
        expectedGeneration: 0,
        snapshot: { secret: true },
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_FORBIDDEN" });
    expect(casSnapshot).not.toHaveBeenCalled();
  });

  it("preserves local state as unsynced on CAS conflict", async () => {
    const snapshot = { elements: [{ id: "unsynced-local-change" }] };
    const result = await saveVaultSnapshot({
      persistence: createPersistence({
        casSnapshot: vi.fn().mockRejectedValue(
          new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
            recoverable: true,
          }),
        ),
      }),
      vaultId,
      invitationCapability,
      rootKey: generateVaultRootKey(),
      role: "editor",
      expectedGeneration: 9,
      snapshot,
    });

    expect(result).toEqual({
      status: "unsynced",
      reason: "conflict",
      errorCode: "VAULT_SNAPSHOT_CONFLICT",
      snapshot,
      expectedGeneration: 9,
    });
    expect(result.snapshot).toBe(snapshot);
  });
});
