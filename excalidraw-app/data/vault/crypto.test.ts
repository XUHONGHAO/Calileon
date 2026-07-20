import { describe, expect, it } from "vitest";

import {
  decryptVaultJson,
  encryptVaultJson,
  generateVaultInvitationCapability,
  generateVaultRootKey,
  hashVaultInvitationCapability,
} from "./crypto";

import type {
  VaultEnvelopeContextV1,
  VaultSnapshotEncryptedEnvelopeV1,
} from "./types";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const messageId = "123e4567-e89b-42d3-a456-426614174001";

const snapshotContext: VaultEnvelopeContextV1 = {
  version: 1,
  vaultId,
  purpose: "snapshot",
  messageType: "snapshot.scene",
  messageId,
  generation: 1,
};

describe("Vault crypto contract", () => {
  it("uses independent 256-bit root and invitation secrets", () => {
    expect(generateVaultRootKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateVaultInvitationCapability()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("roundtrips with HKDF purpose isolation and authenticated AAD", async () => {
    const rootKey = generateVaultRootKey();
    const payload = { marker: "P4-PLAINTEXT-SENTINEL-20260713" };
    const envelope = await encryptVaultJson(rootKey, snapshotContext, payload);
    const snapshotEnvelope = envelope as VaultSnapshotEncryptedEnvelopeV1;

    expect(JSON.stringify(snapshotEnvelope)).not.toContain(payload.marker);
    await expect(decryptVaultJson(rootKey, snapshotEnvelope)).resolves.toEqual(
      payload,
    );

    await expect(
      decryptVaultJson(rootKey, { ...snapshotEnvelope, generation: 2 }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_DECRYPT_FAILED" }),
    );
    await expect(
      decryptVaultJson(rootKey, {
        ...snapshotEnvelope,
        vaultId: "123e4567-e89b-42d3-a456-426614174999",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_DECRYPT_FAILED" }),
    );
  });

  it("domain-separates the stable capability hash by Vault", async () => {
    const capability = `${"C".repeat(42)}A`;
    const first = await hashVaultInvitationCapability(vaultId, capability);
    const repeated = await hashVaultInvitationCapability(vaultId, capability);
    const otherVault = await hashVaultInvitationCapability(
      "123e4567-e89b-42d3-a456-426614174999",
      capability,
    );

    expect(first).toBe(repeated);
    expect(first).toBe("wcYM_jIAidxAPcwmsNs_Y4h_IwRTRRghkfBd6n767XQ");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(otherVault).not.toBe(first);
  });

  it("maps an incorrect key to the stable authentication error", async () => {
    const envelope = await encryptVaultJson(
      generateVaultRootKey(),
      snapshotContext,
      { ok: true },
    );
    await expect(
      decryptVaultJson(generateVaultRootKey(), envelope),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_DECRYPT_FAILED" }),
    );
  });
});
