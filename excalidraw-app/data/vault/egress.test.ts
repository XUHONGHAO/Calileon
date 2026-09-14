import { describe, expect, it } from "vitest";

import {
  assertVaultEgressAllowed,
  evaluateVaultEgress,
  vaultEgressGuard,
  VAULT_EGRESS_DENIED,
} from "./egress";
import { VaultError } from "./errors";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const messageId = "123e4567-e89b-42d3-a456-426614174001";

const envelopes = {
  "vault.realtime.encrypted": {
    version: 1 as const,
    vaultId,
    purpose: "realtime" as const,
    messageType: "realtime.content" as const,
    messageId,
    senderSessionId: "123e4567-e89b-42d3-a456-426614174002",
    sequence: 1,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
  "vault.snapshot.encrypted": {
    version: 1 as const,
    vaultId,
    purpose: "snapshot" as const,
    messageType: "snapshot.scene" as const,
    messageId,
    generation: 1,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
  "vault.asset.encrypted": {
    version: 1 as const,
    vaultId,
    purpose: "asset" as const,
    messageType: "asset.content" as const,
    messageId,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

describe("VaultEgressGuard", () => {
  it("allows only local render and strict encrypted Vault transports", () => {
    expect(evaluateVaultEgress({ operation: "local.render" })).toEqual({
      allowed: true,
      operation: "local.render",
    });

    for (const [operation, envelope] of Object.entries(envelopes)) {
      expect(evaluateVaultEgress({ operation, envelope })).toEqual({
        allowed: true,
        operation,
      });
    }
  });

  it.each(["ai", "external.embed", "external.iframe", "remote.media"] as const)(
    "denies active Vault third-party egress: %s",
    (operation) => {
      expect(evaluateVaultEgress({ operation })).toEqual({
        allowed: false,
        operation,
        code: VAULT_EGRESS_DENIED,
        reason: "third-party-egress-forbidden",
      });
    },
  );

  it.each([
    "persistence.plain",
    "persistence.legacy",
    "export.plain",
    "export.legacy",
  ] as const)("denies active Vault plain or legacy egress: %s", (operation) => {
    expect(evaluateVaultEgress({ operation })).toEqual({
      allowed: false,
      operation,
      code: VAULT_EGRESS_DENIED,
      reason: "plain-or-legacy-egress-forbidden",
    });
  });

  it("fails closed for unknown, malformed, mismatched, or decorated requests", () => {
    const requests = [
      null,
      {},
      { operation: "vault.future.encrypted" },
      { operation: "local.render", scene: "plain scene" },
      { operation: "vault.snapshot.encrypted" },
      {
        operation: "vault.snapshot.encrypted",
        envelope: envelopes["vault.realtime.encrypted"],
      },
      {
        operation: "vault.asset.encrypted",
        envelope: envelopes["vault.asset.encrypted"],
        capability: "raw-secret",
      },
    ];

    for (const request of requests) {
      expect(evaluateVaultEgress(request)).toMatchObject({
        allowed: false,
        code: VAULT_EGRESS_DENIED,
      });
    }
  });

  it("throws a stable payload-free error", () => {
    const sentinel = "P4-VAULT-PLAINTEXT-SENTINEL-20260715";
    let thrown: unknown;

    try {
      assertVaultEgressAllowed({
        operation: "ai",
        payload: sentinel,
        capability: "raw-secret",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VaultError);
    expect(thrown).toMatchObject({
      code: VAULT_EGRESS_DENIED,
      message: "Vault egress is denied.",
      recoverable: false,
    });
    expect(JSON.stringify(thrown)).not.toContain(sentinel);
    expect(JSON.stringify(thrown)).not.toContain("raw-secret");
  });

  it("allows one confirmed managed AI request and consumes the authorization", () => {
    const request = {
      operation: "ai" as const,
      transport: "managed-gateway" as const,
      authorization: vaultEgressGuard.issueManagedAIAuthorization({
        userId: "user-1",
        prompt: "Summarize the selected image",
        attachmentIds: ["image-1"],
        confirmed: true,
      }),
      userId: "user-1",
      prompt: "Summarize the selected image",
      attachmentIds: ["image-1"],
      contentAudit: false as const,
    };

    expect(evaluateVaultEgress(request)).toEqual({
      allowed: true,
      operation: "ai",
    });
    expect(() => assertVaultEgressAllowed(request)).not.toThrow();
    expect(evaluateVaultEgress(request)).toMatchObject({
      allowed: false,
      code: VAULT_EGRESS_DENIED,
    });
  });

  it("rejects Vault AI authorization changes, audit, BYOK, and full-scene decoration", () => {
    const authorization = vaultEgressGuard.issueManagedAIAuthorization({
      userId: "user-1",
      prompt: "Allowed prompt",
      attachmentIds: [],
      confirmed: true,
    });
    const base = {
      operation: "ai",
      transport: "managed-gateway",
      authorization,
      userId: "user-1",
      prompt: "Allowed prompt",
      attachmentIds: [],
      contentAudit: false,
    };

    for (const request of [
      { ...base, prompt: "Changed prompt" },
      { ...base, contentAudit: true },
      { ...base, transport: "byok-proxy" },
      { ...base, scene: "full plaintext scene" },
    ]) {
      expect(evaluateVaultEgress(request)).toMatchObject({
        allowed: false,
        code: VAULT_EGRESS_DENIED,
      });
    }
  });

  it("rejects malformed attachment selections and expired one-time authorizations", () => {
    expect(() =>
      vaultEgressGuard.issueManagedAIAuthorization({
        userId: "user-1",
        prompt: "prompt",
        attachmentIds: ["same", "same"],
        confirmed: true,
      }),
    ).toThrowError(expect.objectContaining({ code: VAULT_EGRESS_DENIED }));
    const authorization = vaultEgressGuard.issueManagedAIAuthorization({
      userId: "user-1",
      prompt: "prompt",
      attachmentIds: [],
      confirmed: true,
    });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(
        evaluateVaultEgress({
          operation: "ai",
          transport: "managed-gateway",
          authorization,
          userId: "user-1",
          prompt: "prompt",
          attachmentIds: [],
          contentAudit: false,
        }),
      ).toMatchObject({ allowed: false, code: VAULT_EGRESS_DENIED });
    } finally {
      vi.useRealTimers();
    }
  });
});
