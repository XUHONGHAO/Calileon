import { VaultError } from "./errors";
import { isVaultEncryptedEnvelopeV1 } from "./protocol";

import type {
  VaultAssetEncryptedEnvelopeV1,
  VaultRealtimeEncryptedEnvelopeV1,
  VaultSnapshotEncryptedEnvelopeV1,
} from "./types";

export const VAULT_EGRESS_DENIED = "VAULT_EGRESS_DENIED" as const;

export const VAULT_EGRESS_OPERATIONS = [
  "local.render",
  "vault.realtime.encrypted",
  "vault.snapshot.encrypted",
  "vault.asset.encrypted",
  "ai",
  "external.embed",
  "external.iframe",
  "remote.media",
  "persistence.plain",
  "persistence.legacy",
  "export.plain",
  "export.legacy",
] as const;

export type VaultEgressOperation = typeof VAULT_EGRESS_OPERATIONS[number];

export type VaultAllowedEgressRequest =
  | Readonly<{ operation: "local.render" }>
  | Readonly<{
      operation: "vault.realtime.encrypted";
      envelope: VaultRealtimeEncryptedEnvelopeV1;
    }>
  | Readonly<{
      operation: "vault.snapshot.encrypted";
      envelope: VaultSnapshotEncryptedEnvelopeV1;
    }>
  | Readonly<{
      operation: "vault.asset.encrypted";
      envelope: VaultAssetEncryptedEnvelopeV1;
    }>
  | VaultManagedAIEgressRequest;

export type VaultManagedAIEgressRequest = Readonly<{
  operation: "ai";
  transport: "managed-gateway";
  authorization: string;
  userId: string;
  prompt: string;
  attachmentIds: readonly string[];
  contentAudit: false;
}>;

export type VaultEgressDenialReason =
  | "classification-invalid"
  | "encrypted-envelope-required"
  | "third-party-egress-forbidden"
  | "plain-or-legacy-egress-forbidden";

export type VaultEgressDecision =
  | Readonly<{
      allowed: true;
      operation: VaultAllowedEgressRequest["operation"];
    }>
  | Readonly<{
      allowed: false;
      operation: VaultEgressOperation | "unknown";
      code: typeof VAULT_EGRESS_DENIED;
      reason: VaultEgressDenialReason;
    }>;

const ENCRYPTED_PURPOSE_BY_OPERATION = {
  "vault.realtime.encrypted": "realtime",
  "vault.snapshot.encrypted": "snapshot",
  "vault.asset.encrypted": "asset",
} as const;

const THIRD_PARTY_OPERATIONS = new Set<VaultEgressOperation>([
  "ai",
  "external.embed",
  "external.iframe",
  "remote.media",
]);

const PLAIN_OR_LEGACY_OPERATIONS = new Set<VaultEgressOperation>([
  "persistence.plain",
  "persistence.legacy",
  "export.plain",
  "export.legacy",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeUserId = (value: string) =>
  value.length >= 1 &&
  value.length <= 256 &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => key in value);
};

export const isVaultEgressOperation = (
  value: unknown,
): value is VaultEgressOperation =>
  typeof value === "string" &&
  (VAULT_EGRESS_OPERATIONS as readonly string[]).includes(value);

const deny = (
  operation: VaultEgressOperation | "unknown",
  reason: VaultEgressDenialReason,
): VaultEgressDecision =>
  Object.freeze({
    allowed: false,
    operation,
    code: VAULT_EGRESS_DENIED,
    reason,
  });

/**
 * Fail-closed boundary for an active Vault session.
 *
 * Every possible egress must be classified before reaching a transport. The
 * only network operations accepted here carry a strict Vault encrypted
 * envelope with a purpose matching the selected transport. Ordinary product
 * integrations and plain/legacy persistence or export never receive Vault
 * scene data.
 */
export class VaultEgressGuard {
  private readonly aiAuthorizations = new Map<
    string,
    { userId: string; digest: string; expiresAt: number }
  >();

  private purgeExpired(now = Date.now()) {
    for (const [token, authorization] of this.aiAuthorizations) {
      if (authorization.expiresAt <= now) {
        this.aiAuthorizations.delete(token);
      }
    }
  }

  issueManagedAIAuthorization(input: {
    userId: string;
    prompt: string;
    attachmentIds: readonly string[];
    confirmed: boolean;
  }) {
    this.purgeExpired();
    const prompt = input.prompt.trim();
    const attachmentIds = [...input.attachmentIds];
    if (
      !input.confirmed ||
      !isSafeUserId(input.userId) ||
      !prompt ||
      new TextEncoder().encode(prompt).byteLength > 32 * 1024 ||
      attachmentIds.length > 3 ||
      attachmentIds.some(
        (id) =>
          !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
          attachmentIds.filter((candidate) => candidate === id).length > 1,
      )
    ) {
      throw new VaultError(VAULT_EGRESS_DENIED, "Vault egress is denied.");
    }
    const authorization = globalThis.crypto.randomUUID();
    this.aiAuthorizations.set(authorization, {
      userId: input.userId,
      digest: this.digestAIRequest(input.userId, prompt, attachmentIds),
      expiresAt: Date.now() + 2 * 60_000,
    });
    return authorization;
  }

  private digestAIRequest(
    userId: string,
    prompt: string,
    attachmentIds: readonly string[],
  ) {
    return JSON.stringify({
      userId,
      prompt: prompt.trim(),
      attachmentIds: [...attachmentIds],
    });
  }

  private evaluateManagedAI(request: Record<string, unknown>) {
    this.purgeExpired();
    if (
      !hasExactKeys(request, [
        "operation",
        "transport",
        "authorization",
        "userId",
        "prompt",
        "attachmentIds",
        "contentAudit",
      ]) ||
      request.transport !== "managed-gateway" ||
      request.contentAudit !== false ||
      typeof request.authorization !== "string" ||
      typeof request.userId !== "string" ||
      typeof request.prompt !== "string" ||
      !Array.isArray(request.attachmentIds) ||
      !request.attachmentIds.every((id) => typeof id === "string")
    ) {
      return deny("ai", "classification-invalid");
    }
    const authorization = this.aiAuthorizations.get(request.authorization);
    const digest = this.digestAIRequest(
      request.userId,
      request.prompt,
      request.attachmentIds as string[],
    );
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.userId !== request.userId ||
      authorization.digest !== digest
    ) {
      return deny("ai", "third-party-egress-forbidden");
    }
    return Object.freeze({ allowed: true, operation: "ai" as const });
  }

  evaluate(request: unknown): VaultEgressDecision {
    if (!isRecord(request) || !isVaultEgressOperation(request.operation)) {
      return deny("unknown", "classification-invalid");
    }

    const operation = request.operation;
    if (operation === "ai") {
      if (hasExactKeys(request, ["operation"])) {
        return deny(operation, "third-party-egress-forbidden");
      }
      return this.evaluateManagedAI(request);
    }
    if (operation === "local.render") {
      return hasExactKeys(request, ["operation"])
        ? Object.freeze({ allowed: true, operation })
        : deny(operation, "classification-invalid");
    }

    if (operation in ENCRYPTED_PURPOSE_BY_OPERATION) {
      const expectedPurpose =
        ENCRYPTED_PURPOSE_BY_OPERATION[
          operation as keyof typeof ENCRYPTED_PURPOSE_BY_OPERATION
        ];
      if (
        !hasExactKeys(request, ["operation", "envelope"]) ||
        !isVaultEncryptedEnvelopeV1(request.envelope) ||
        request.envelope.purpose !== expectedPurpose
      ) {
        return deny(operation, "encrypted-envelope-required");
      }

      return Object.freeze({
        allowed: true,
        operation: operation as VaultAllowedEgressRequest["operation"],
      });
    }

    if (THIRD_PARTY_OPERATIONS.has(operation)) {
      return deny(operation, "third-party-egress-forbidden");
    }

    if (PLAIN_OR_LEGACY_OPERATIONS.has(operation)) {
      return deny(operation, "plain-or-legacy-egress-forbidden");
    }

    return deny(operation, "classification-invalid");
  }

  assertAllowed(
    request: unknown,
  ): asserts request is VaultAllowedEgressRequest {
    const decision = this.evaluate(request);
    if (!decision.allowed) {
      throw new VaultError(VAULT_EGRESS_DENIED, "Vault egress is denied.");
    }
    if (
      isRecord(request) &&
      request.operation === "ai" &&
      typeof request.authorization === "string"
    ) {
      this.aiAuthorizations.delete(request.authorization);
    }
  }
}

export const vaultEgressGuard: VaultEgressGuard = new VaultEgressGuard();
Object.freeze(vaultEgressGuard);

export const evaluateVaultEgress = (request: unknown): VaultEgressDecision =>
  vaultEgressGuard.evaluate(request);

export function assertVaultEgressAllowed(
  request: unknown,
): asserts request is VaultAllowedEgressRequest {
  vaultEgressGuard.assertAllowed(request);
}
