import { MemoryGatewayStore } from "../src/gateway/store.js";

import type {
  EncryptedEnvelope,
  GatewayIdentity,
  GatewayQuotaPolicy,
} from "../src/gateway/types.js";

const identity: GatewayIdentity = {
  issuer: "issuer",
  subject: "user-1",
  source: "jwt",
};
const policy: GatewayQuotaPolicy = {
  id: "standard",
  dailyCredits: 2,
  monthlyCredits: 5,
  requestsPerMinute: 10,
  maxConcurrency: 1,
};
const envelope: EncryptedEnvelope = {
  provider: "local-kek",
  keyId: "test",
  wrappedKey: "wrapped",
  iv: "iv",
  tag: "tag",
  ciphertext: "ciphertext",
};

const reserve = (store: MemoryGatewayStore, requestId: string, costUnits = 1) =>
  store.reserve({
    identity,
    requestId,
    routeId: "route",
    operation: "stream",
    costUnits,
    defaultPolicy: policy,
    policies: [policy],
    leaseMs: 1_000,
  });

describe("managed gateway in-memory store contract", () => {
  it("atomically enforces concurrency/quota and releases pre-dispatch credits", async () => {
    const store = new MemoryGatewayStore();
    await reserve(store, "request-1");
    await expect(reserve(store, "request-2")).rejects.toMatchObject({
      code: "AI_GATEWAY_CONCURRENCY_EXCEEDED",
    });
    await store.release("request-1", "PRE_DISPATCH_FAILURE");
    await reserve(store, "request-2", 2);
    await expect(store.markDispatched("request-2")).resolves.toBe(true);
    await expect(store.markDispatched("request-2")).resolves.toBe(false);
    await store.finish({
      requestId: "request-2",
      status: "succeeded",
      providerAttempts: 2,
      responseBytes: 9,
      durationMs: 12,
    });
    const quota = await store.getQuota(identity, policy, [policy]);
    expect(quota.daily.used).toBe(2);
    expect(quota.activeRequests).toBe(0);
    await expect(reserve(store, "request-3")).rejects.toMatchObject({
      code: "AI_GATEWAY_QUOTA_EXCEEDED",
    });
  });

  it("binds audit drafts once and purges expired encrypted content", async () => {
    const store = new MemoryGatewayStore();
    const auditId = await store.createAudit({
      identity,
      routeId: "route",
      envelope,
      contentBytes: 12,
      expiresAt: Date.now() + 1_000,
    });
    await expect(
      store.bindAudit(identity, auditId, "request-1", "route"),
    ).resolves.toBe(true);
    await expect(
      store.bindAudit(identity, auditId, "request-2", "route"),
    ).resolves.toBe(false);
    await expect(store.listAudits(identity, 10)).resolves.toMatchObject([
      { id: auditId, requestId: "request-1", contentBytes: 12 },
    ]);
    await expect(
      store.getAuditRecord(identity, auditId),
    ).resolves.toMatchObject({
      id: auditId,
      requestId: "request-1",
      routeId: "route",
    });
    await store.recordAuditAccess({
      auditId,
      operator: "operator",
      reason: "incident review",
    });
    expect(store.auditAccessEvents).toHaveLength(1);
    await store.purgeExpired(Date.now() + 2_000);
    await expect(store.getAuditEnvelope(identity, auditId)).resolves.toBeNull();
  });

  it("uses one-time device codes and hashed one-hour sessions", async () => {
    const store = new MemoryGatewayStore();
    await store.createDeviceAuthorization({
      deviceCodeHash: "device-hash",
      userCodeHash: "user-hash",
      userCode: "ABCD-EFGH",
      expiresAt: Date.now() + 1_000,
      intervalSeconds: 5,
    });
    await expect(
      store.approveDeviceAuthorization({ userCodeHash: "user-hash", identity }),
    ).resolves.toBe(true);
    await expect(
      store.approveDeviceAuthorization({ userCodeHash: "user-hash", identity }),
    ).resolves.toBe(false);
    await expect(
      store.exchangeDeviceAuthorization({
        deviceCodeHash: "device-hash",
        tokenHash: "token-hash",
        tokenExpiresAt: Date.now() + 60 * 60_000,
      }),
    ).resolves.toBe("approved");
    await expect(
      store.exchangeDeviceAuthorization({
        deviceCodeHash: "device-hash",
        tokenHash: "second-token",
        tokenExpiresAt: Date.now() + 60 * 60_000,
      }),
    ).resolves.not.toBe("approved");
    await expect(store.resolveDeviceToken("token-hash")).resolves.toMatchObject(
      {
        subject: "user-1",
        source: "device",
      },
    );
  });

  it("deletes all account-owned gateway data without touching another user", async () => {
    const store = new MemoryGatewayStore();
    const other: GatewayIdentity = {
      issuer: identity.issuer,
      subject: "user-2",
      source: "jwt",
    };
    await reserve(store, "request-1");
    await store.setAuditConsent(identity, true);
    const audit = await store.createAudit({
      identity,
      routeId: "route",
      envelope,
      contentBytes: 1,
      expiresAt: Date.now() + 10_000,
    });
    await store.recordAuditAccess({
      auditId: audit,
      reason: "account deletion test",
      operator: "operator",
    });
    await store.assignPolicy(identity, "standard");
    await store.createDeviceAuthorization({
      deviceCodeHash: "device-hash",
      userCodeHash: "user-hash",
      userCode: "ABCD-EFGH",
      expiresAt: Date.now() + 10_000,
      intervalSeconds: 5,
    });
    await store.approveDeviceAuthorization({
      userCodeHash: "user-hash",
      identity,
    });
    await store.exchangeDeviceAuthorization({
      deviceCodeHash: "device-hash",
      tokenHash: "token-hash",
      tokenExpiresAt: Date.now() + 10_000,
    });
    await store.createAudit({
      identity: other,
      routeId: "route",
      envelope,
      contentBytes: 1,
      expiresAt: Date.now() + 10_000,
    });

    await store.deleteIdentityData(identity);

    await expect(store.listUsage(identity, 10)).resolves.toHaveLength(0);
    await expect(store.listAudits(identity, 10)).resolves.toHaveLength(0);
    await expect(store.getAuditConsent(identity)).resolves.toBe(false);
    expect(store.assignments.has("issuer\nuser-1")).toBe(false);
    expect(store.sessions.has("token-hash")).toBe(false);
    expect(store.auditAccessEvents).toHaveLength(0);
    await expect(store.listAudits(other, 10)).resolves.toHaveLength(1);
  });
});
