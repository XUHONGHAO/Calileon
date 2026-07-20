import { assertVaultDeploymentReadyToken } from "./capabilities";
import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";
import {
  assertVaultEncryptedEnvelopeV1,
  canVaultRoleSendMessage,
} from "./protocol";

import type { VaultDeploymentReady } from "./capabilities";
import type {
  VaultSocketBroadcast,
  VaultSocketJoinRequest,
} from "./backendContract";
import type { VaultCapabilityResolution, VaultRole } from "./types";

const vaultAdmissionBrand: unique symbol = Symbol("VaultAdmission");
const issuedVaultAdmissions = new WeakSet<object>();

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
const JOIN_REQUEST_KEYS = [
  "protocolVersion",
  "vaultId",
  "invitationCapability",
  "senderSessionId",
] as const;
const BROADCAST_KEYS = [
  "sourceSocketId",
  "admittedSenderSessionId",
  "envelope",
] as const;
const RESOLUTION_KEYS = [
  "vaultId",
  "invitationId",
  "role",
  "authorizationVersion",
  "activeRoomId",
  "snapshotGeneration",
  "expiresAt",
] as const;

export interface VaultAdmission {
  readonly kind: "vault-admission";
  readonly vaultId: string;
  readonly activeRoomId: string;
  readonly role: VaultRole;
  readonly authorizationVersion: number;
  readonly invitationId: string;
  readonly senderSessionId: string;
  readonly expiresAt: number | null;
  readonly [vaultAdmissionBrand]: true;
}

const isSafeIntegerAtLeast = (value: unknown, minimum: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

export function assertVaultSocketJoinRequest(
  value: unknown,
): asserts value is VaultSocketJoinRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault socket join request is invalid.",
    );
  }
  const request = value as Record<string, unknown>;
  if (
    !hasExactKeys(request, JOIN_REQUEST_KEYS) ||
    request.protocolVersion !== VAULT_PROTOCOL_VERSION ||
    typeof request.vaultId !== "string" ||
    !UUID_RE.test(request.vaultId) ||
    typeof request.invitationCapability !== "string" ||
    !CAPABILITY_RE.test(request.invitationCapability) ||
    typeof request.senderSessionId !== "string" ||
    !UUID_V4_RE.test(request.senderSessionId)
  ) {
    throw new VaultError(
      request.protocolVersion !== VAULT_PROTOCOL_VERSION
        ? "VAULT_PROTOCOL_UNSUPPORTED"
        : "VAULT_CAPABILITY_INVALID",
      "Vault socket join request is invalid.",
    );
  }
}

export function assertVaultCapabilityResolution(
  value: unknown,
  now = Date.now(),
): asserts value is VaultCapabilityResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault capability resolution is invalid.",
    );
  }

  const resolution = value as Record<string, unknown>;
  const keys = Object.keys(resolution);
  if (
    keys.length !== RESOLUTION_KEYS.length ||
    !RESOLUTION_KEYS.every((key) => keys.includes(key)) ||
    typeof resolution.vaultId !== "string" ||
    !UUID_RE.test(resolution.vaultId) ||
    typeof resolution.invitationId !== "string" ||
    !UUID_RE.test(resolution.invitationId) ||
    (resolution.role !== "viewer" && resolution.role !== "editor") ||
    !isSafeIntegerAtLeast(resolution.authorizationVersion, 1) ||
    typeof resolution.activeRoomId !== "string" ||
    !ACTIVE_ROOM_ID_RE.test(resolution.activeRoomId) ||
    !isSafeIntegerAtLeast(resolution.snapshotGeneration, 0) ||
    (resolution.expiresAt !== null &&
      !isSafeIntegerAtLeast(resolution.expiresAt, 0))
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault capability resolution is invalid.",
    );
  }

  const expiresAt = resolution.expiresAt as number | null;
  if (expiresAt !== null && expiresAt <= now) {
    throw new VaultError(
      "VAULT_CAPABILITY_EXPIRED",
      "Vault capability has expired.",
    );
  }
}

export const issueVaultAdmission = (
  deployment: VaultDeploymentReady,
  resolution: VaultCapabilityResolution,
  senderSessionId: string,
  now = Date.now(),
): VaultAdmission => {
  assertVaultDeploymentReadyToken(deployment);
  assertVaultCapabilityResolution(resolution, now);
  if (!UUID_V4_RE.test(senderSessionId)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault sender session is invalid.",
    );
  }

  const admission = Object.freeze({
    kind: "vault-admission" as const,
    vaultId: resolution.vaultId,
    activeRoomId: resolution.activeRoomId,
    role: resolution.role,
    authorizationVersion: resolution.authorizationVersion,
    invitationId: resolution.invitationId,
    senderSessionId,
    expiresAt: resolution.expiresAt,
    [vaultAdmissionBrand]: true as const,
  });
  issuedVaultAdmissions.add(admission);
  return admission;
};

export const isVaultAdmission = (
  value: unknown,
  now = Date.now(),
): value is VaultAdmission => {
  if (
    typeof value !== "object" ||
    value === null ||
    !issuedVaultAdmissions.has(value)
  ) {
    return false;
  }
  const expiresAt = (value as VaultAdmission).expiresAt;
  return expiresAt === null || expiresAt > now;
};

export function assertVaultAdmissionToken(
  value: unknown,
  now = Date.now(),
): asserts value is VaultAdmission {
  assertVaultAdmissionIssuedToken(value);
  const expiresAt = value.expiresAt;
  if (expiresAt !== null && expiresAt <= now) {
    throw new VaultError(
      "VAULT_CAPABILITY_EXPIRED",
      "Vault admission has expired.",
    );
  }
}

export function assertVaultAdmissionIssuedToken(
  value: unknown,
): asserts value is VaultAdmission {
  if (
    typeof value !== "object" ||
    value === null ||
    !issuedVaultAdmissions.has(value)
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault admission proof is missing or invalid.",
    );
  }
}

/**
 * Pure room-server wire guard. The byte count must be measured from the
 * received wire payload, never trusted from client-controlled JSON.
 */
export function assertVaultSocketBroadcastForAdmission(
  admission: VaultAdmission,
  value: unknown,
  payloadBytes: number,
  maxPayloadBytes: number,
): asserts value is VaultSocketBroadcast {
  assertVaultAdmissionToken(admission);
  if (
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 0 ||
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault wire payload size is invalid.",
    );
  }
  if (payloadBytes > maxPayloadBytes) {
    throw new VaultError(
      "VAULT_PAYLOAD_TOO_LARGE",
      "Vault wire payload is too large.",
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value, BROADCAST_KEYS)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault socket broadcast is invalid.",
    );
  }

  const broadcast = value as Record<string, unknown>;
  if (
    typeof broadcast.sourceSocketId !== "string" ||
    broadcast.sourceSocketId.length === 0 ||
    broadcast.admittedSenderSessionId !== admission.senderSessionId
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault broadcast transport identity is invalid.",
    );
  }
  assertVaultEncryptedEnvelopeV1(broadcast.envelope);
  if (
    broadcast.envelope.purpose !== "realtime" ||
    broadcast.envelope.vaultId !== admission.vaultId ||
    broadcast.envelope.senderSessionId !== admission.senderSessionId ||
    !canVaultRoleSendMessage(admission.role, broadcast.envelope.messageType)
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_FORBIDDEN",
      "Vault broadcast is not authorized by the admission.",
    );
  }
}
