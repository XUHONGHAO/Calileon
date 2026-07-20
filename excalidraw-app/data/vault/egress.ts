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
  evaluate(request: unknown): VaultEgressDecision {
    if (!isRecord(request) || !isVaultEgressOperation(request.operation)) {
      return deny("unknown", "classification-invalid");
    }

    const operation = request.operation;
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
    if (!this.evaluate(request).allowed) {
      throw new VaultError(VAULT_EGRESS_DENIED, "Vault egress is denied.");
    }
  }
}

export const vaultEgressGuard: VaultEgressGuard = Object.freeze(
  new VaultEgressGuard(),
);

export const evaluateVaultEgress = (request: unknown): VaultEgressDecision =>
  vaultEgressGuard.evaluate(request);

export function assertVaultEgressAllowed(
  request: unknown,
): asserts request is VaultAllowedEgressRequest {
  vaultEgressGuard.assertAllowed(request);
}
