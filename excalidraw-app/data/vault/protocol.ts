import {
  VAULT_AAD_DOMAIN,
  VAULT_FIRST_MESSAGE_SEQUENCE,
  VAULT_IV_BYTES,
  VAULT_PROTOCOL_VERSION,
} from "./constants";
import { isCanonicalBase64Url } from "./encoding";
import { VaultError } from "./errors";

import type {
  VaultEncryptedEnvelopeV1,
  VaultEnvelopeContextV1,
  VaultMessageType,
  VaultRole,
} from "./types";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const VAULT_MESSAGE_TYPES = [
  "realtime.content",
  "realtime.presence",
  "snapshot.scene",
  "asset.content",
] as const;

const REALTIME_KEYS = [
  "version",
  "vaultId",
  "purpose",
  "messageType",
  "messageId",
  "senderSessionId",
  "sequence",
  "iv",
  "ciphertext",
] as const;
const SNAPSHOT_KEYS = [
  "version",
  "vaultId",
  "purpose",
  "messageType",
  "messageId",
  "generation",
  "iv",
  "ciphertext",
] as const;
const ASSET_KEYS = [
  "version",
  "vaultId",
  "purpose",
  "messageType",
  "messageId",
  "iv",
  "ciphertext",
] as const;

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const isSafeIntegerAtLeast = (value: unknown, minimum: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const assertCommonContext = (value: Record<string, unknown>) => {
  if (value.version !== VAULT_PROTOCOL_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported Vault protocol version.",
    );
  }
  if (
    typeof value.messageType !== "string" ||
    !VAULT_MESSAGE_TYPES.includes(value.messageType as VaultMessageType)
  ) {
    throw new VaultError(
      "VAULT_MESSAGE_TYPE_UNSUPPORTED",
      "Unsupported Vault message type.",
    );
  }
  if (
    typeof value.vaultId !== "string" ||
    !UUID_RE.test(value.vaultId) ||
    typeof value.messageId !== "string" ||
    !UUID_V4_RE.test(value.messageId)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault envelope context.",
    );
  }
};

export function assertVaultEnvelopeContextV1(
  value: unknown,
): asserts value is VaultEnvelopeContextV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault envelope context.",
    );
  }

  const context = value as Record<string, unknown>;
  assertCommonContext(context);

  if (context.purpose === "realtime") {
    if (
      (context.messageType !== "realtime.content" &&
        context.messageType !== "realtime.presence") ||
      typeof context.senderSessionId !== "string" ||
      !UUID_V4_RE.test(context.senderSessionId) ||
      !isSafeIntegerAtLeast(context.sequence, VAULT_FIRST_MESSAGE_SEQUENCE) ||
      !hasExactKeys(context, REALTIME_KEYS.slice(0, -2))
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Invalid realtime envelope context.",
      );
    }
    return;
  }

  if (context.purpose === "snapshot") {
    if (
      context.messageType !== "snapshot.scene" ||
      !isSafeIntegerAtLeast(context.generation, 1) ||
      !hasExactKeys(context, SNAPSHOT_KEYS.slice(0, -2))
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Invalid snapshot envelope context.",
      );
    }
    return;
  }

  if (
    context.purpose !== "asset" ||
    context.messageType !== "asset.content" ||
    !hasExactKeys(context, ASSET_KEYS.slice(0, -2))
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid asset envelope context.",
    );
  }
}

export function assertVaultEncryptedEnvelopeV1(
  value: unknown,
): asserts value is VaultEncryptedEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault envelope.");
  }

  const envelope = value as Record<string, unknown>;
  const expectedKeys =
    envelope.purpose === "realtime"
      ? REALTIME_KEYS
      : envelope.purpose === "snapshot"
      ? SNAPSHOT_KEYS
      : ASSET_KEYS;

  if (!hasExactKeys(envelope, expectedKeys)) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault envelope fields.",
    );
  }

  const { iv, ciphertext, ...context } = envelope;
  assertVaultEnvelopeContextV1(context);

  if (
    typeof iv !== "string" ||
    !isCanonicalBase64Url(iv, VAULT_IV_BYTES) ||
    typeof ciphertext !== "string" ||
    !isCanonicalBase64Url(ciphertext)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault envelope ciphertext.",
    );
  }
}

export const isVaultEncryptedEnvelopeV1 = (
  value: unknown,
): value is VaultEncryptedEnvelopeV1 => {
  try {
    assertVaultEncryptedEnvelopeV1(value);
    return true;
  } catch {
    return false;
  }
};

export const encodeVaultEnvelopeAadV1 = (
  context: VaultEnvelopeContextV1,
): Uint8Array<ArrayBuffer> => {
  assertVaultEnvelopeContextV1(context);
  return new TextEncoder().encode(
    JSON.stringify([
      VAULT_AAD_DOMAIN,
      context.version,
      context.vaultId,
      context.purpose,
      context.messageType,
      context.messageId,
      context.purpose === "realtime" ? context.senderSessionId : null,
      context.purpose === "realtime" ? context.sequence : null,
      context.purpose === "snapshot" ? context.generation : null,
    ]),
  );
};

const createUuidV4 = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

export const createVaultMessageId = createUuidV4;
export const createVaultSenderSessionId = createUuidV4;

export const canVaultRoleSendMessage = (
  role: VaultRole,
  messageType: VaultMessageType,
): boolean => role === "editor" || messageType === "realtime.presence";

export interface VaultReplayState {
  readonly highestSequenceBySession: Map<string, number>;
  readonly seenMessageIds: Set<string>;
  readonly messageIdOrder: string[];
  readonly maxMessageIds: number;
}

export const createVaultReplayState = (
  maxMessageIds = 2048,
): VaultReplayState => ({
  highestSequenceBySession: new Map(),
  seenMessageIds: new Set(),
  messageIdOrder: [],
  maxMessageIds,
});

export const acceptVaultRealtimeEnvelope = (
  state: VaultReplayState,
  envelope: VaultEncryptedEnvelopeV1,
) => {
  assertVaultRealtimeEnvelopeFresh(state, envelope);
  commitVaultRealtimeEnvelope(state, envelope);
};

export const assertVaultRealtimeEnvelopeFresh = (
  state: VaultReplayState,
  envelope: VaultEncryptedEnvelopeV1,
) => {
  assertVaultEncryptedEnvelopeV1(envelope);
  if (envelope.purpose !== "realtime") {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Expected realtime envelope.",
    );
  }
  if (state.seenMessageIds.has(envelope.messageId)) {
    throw new VaultError("VAULT_REPLAY_REJECTED", "Duplicate Vault message.");
  }
  const highest =
    state.highestSequenceBySession.get(envelope.senderSessionId) ?? 0;
  if (envelope.sequence <= highest) {
    throw new VaultError("VAULT_SEQUENCE_REJECTED", "Stale Vault sequence.");
  }
};

export const commitVaultRealtimeEnvelope = (
  state: VaultReplayState,
  envelope: VaultEncryptedEnvelopeV1,
) => {
  if (envelope.purpose !== "realtime") {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Expected realtime envelope.",
    );
  }
  state.seenMessageIds.add(envelope.messageId);
  state.messageIdOrder.push(envelope.messageId);
  while (state.messageIdOrder.length > state.maxMessageIds) {
    const expiredMessageId = state.messageIdOrder.shift();
    if (expiredMessageId) {
      state.seenMessageIds.delete(expiredMessageId);
    }
  }
  state.highestSequenceBySession.set(
    envelope.senderSessionId,
    envelope.sequence,
  );
};
