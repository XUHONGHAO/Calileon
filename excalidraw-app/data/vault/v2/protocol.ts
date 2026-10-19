/**
 * Vault v2 (P4c) encrypted sync protocol. W2 design §2–§5, ADR 0030 §3.
 *
 * Outer envelope: an exact allowlist of 13 fields (no `senderSessionId`, no
 * `sequence`). AAD covers the 11 non-crypto fields in a fixed order. Every
 * `purpose` (and the protocol version) gets its own HKDF sub-key, so an
 * envelope copied to another purpose/Vault cannot be decrypted (N6).
 */
import {
  VAULT_AAD_DOMAIN,
  VAULT_BASE64URL_SECRET_LENGTH,
  VAULT_IV_BYTES,
  VAULT_KEY_DERIVATION_DOMAIN,
  VAULT_SECRET_BYTES,
} from "../constants";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  isCanonicalBase64Url,
} from "../encoding";
import { VaultError } from "../errors";

export const VAULT_V2_PROTOCOL_VERSION = 2 as const;
export const VAULT_V2_ENVELOPE_VERSION = 2 as const;
export const VAULT_V2_SCHEMA_VERSION = 2 as const;

export const VAULT_V2_PURPOSES = [
  "realtime.content",
  "realtime.request",
  "realtime.presence",
  "snapshot",
] as const;
export type VaultV2Purpose = typeof VAULT_V2_PURPOSES[number];

export const VAULT_V2_MESSAGE_TYPES = [
  "sync.update",
  "sync.context",
  "sync.snapshot-request",
  "snapshot.scene",
  "presence.ephemeral",
] as const;
export type VaultV2MessageType = typeof VAULT_V2_MESSAGE_TYPES[number];

/** purpose ⇄ messageType pairs (S-5, N20) */
export const VAULT_V2_PURPOSE_OF: Readonly<
  Record<VaultV2MessageType, VaultV2Purpose>
> = {
  "sync.update": "realtime.content",
  "sync.context": "realtime.request",
  "sync.snapshot-request": "realtime.request",
  "snapshot.scene": "snapshot",
  "presence.ephemeral": "realtime.presence",
};

/** room-server limit is 1 MiB per message; raw bytes per chunk (W2 §5) */
export const VAULT_V2_CHUNK_RAW_BYTES = 480_000;
export const VAULT_V2_MAX_CHUNKS = 64;
export const VAULT_V2_MAX_ENVELOPE_BYTES = 1024 * 1024;

export type VaultEnvelopeV2 = {
  version: typeof VAULT_V2_ENVELOPE_VERSION;
  schemaVersion: typeof VAULT_V2_SCHEMA_VERSION;
  protocolVersion: typeof VAULT_V2_PROTOCOL_VERSION;
  vaultId: string;
  roomId: string;
  purpose: VaultV2Purpose;
  messageType: VaultV2MessageType;
  messageId: string;
  generation: number;
  chunkIndex: number;
  chunkCount: number;
  iv: string;
  ciphertext: string;
};

export type VaultEnvelopeContextV2 = Omit<VaultEnvelopeV2, "iv" | "ciphertext">;

const ENVELOPE_KEYS = [
  "version",
  "schemaVersion",
  "protocolVersion",
  "vaultId",
  "roomId",
  "purpose",
  "messageType",
  "messageId",
  "generation",
  "chunkIndex",
  "chunkCount",
  "iv",
  "ciphertext",
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const invalid = (message: string): never => {
  throw new VaultError("VAULT_ENVELOPE_INVALID", message);
};

const isInt = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

function assertContext(value: Record<string, unknown>) {
  if (value.version !== VAULT_V2_ENVELOPE_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported envelope version.",
    );
  }
  if (value.protocolVersion !== VAULT_V2_PROTOCOL_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported protocol version.",
    );
  }
  if (value.schemaVersion !== VAULT_V2_SCHEMA_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported schema version.",
    );
  }
  if (typeof value.vaultId !== "string" || !UUID_RE.test(value.vaultId)) {
    invalid("Invalid vaultId.");
  }
  if (typeof value.roomId !== "string" || !ROOM_ID_RE.test(value.roomId)) {
    invalid("Invalid roomId.");
  }
  if (!(VAULT_V2_PURPOSES as readonly unknown[]).includes(value.purpose)) {
    invalid("Unknown purpose.");
  }
  if (
    !(VAULT_V2_MESSAGE_TYPES as readonly unknown[]).includes(value.messageType)
  ) {
    invalid("Unknown messageType.");
  }
  if (
    VAULT_V2_PURPOSE_OF[value.messageType as VaultV2MessageType] !==
    value.purpose
  ) {
    invalid("purpose does not match messageType.");
  }
  if (typeof value.messageId !== "string" || !UUID_RE.test(value.messageId)) {
    invalid("Invalid messageId.");
  }
  if (!isInt(value.generation, 0)) {
    invalid("Invalid generation.");
  }
  if (!isInt(value.chunkCount, 1, VAULT_V2_MAX_CHUNKS)) {
    invalid("Invalid chunkCount.");
  }
  if (!isInt(value.chunkIndex, 0, (value.chunkCount as number) - 1)) {
    invalid("Invalid chunkIndex.");
  }
}

/** exact-field allowlist (N1–N4) */
export function assertVaultEnvelopeV2(
  value: unknown,
): asserts value is VaultEnvelopeV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Envelope must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...ENVELOPE_KEYS].sort().join(",")) {
    invalid("Envelope fields do not match the v2 allowlist.");
  }
  assertContext(record);
  if (
    typeof record.iv !== "string" ||
    !isCanonicalBase64Url(record.iv, VAULT_IV_BYTES)
  ) {
    invalid("Invalid iv.");
  }
  if (typeof record.ciphertext !== "string") {
    invalid("Invalid ciphertext.");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(record.ciphertext as string);
  } catch {
    return invalid("Invalid ciphertext encoding.");
  }
  if (bytes.byteLength < 16) {
    invalid("Ciphertext too short.");
  }
}

export const encodeVaultEnvelopeAadV2 = (context: VaultEnvelopeContextV2) =>
  new TextEncoder().encode(
    JSON.stringify([
      VAULT_AAD_DOMAIN,
      context.version,
      context.schemaVersion,
      context.protocolVersion,
      context.vaultId.toLowerCase(),
      context.roomId,
      context.purpose,
      context.messageType,
      context.messageId,
      context.generation,
      context.chunkIndex,
      context.chunkCount,
    ]),
  );

// ------------------------------------------------------------------ keys

const requireCrypto = (): Crypto => {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  return globalThis.crypto;
};

export type VaultV2Keys = (purpose: VaultV2Purpose) => Promise<CryptoKey>;

/** per-purpose AES-GCM keys for one Vault; separate from v1 by version in the salt */
export const createVaultV2Keys = (
  rootKey: string,
  vaultId: string,
): VaultV2Keys => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64UrlToBytes(rootKey);
  } catch {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault secret.");
  }
  if (
    rootKey.length !== VAULT_BASE64URL_SECRET_LENGTH ||
    raw.byteLength !== VAULT_SECRET_BYTES ||
    !isCanonicalBase64Url(rootKey, VAULT_SECRET_BYTES)
  ) {
    throw new VaultError("VAULT_KEY_INVALID", "Invalid Vault secret.");
  }
  const cache = new Map<VaultV2Purpose, Promise<CryptoKey>>();
  return (purpose) => {
    let key = cache.get(purpose);
    if (!key) {
      const crypto = requireCrypto();
      key = crypto.subtle
        .importKey("raw", raw, "HKDF", false, ["deriveKey"])
        .then((material) =>
          crypto.subtle.deriveKey(
            {
              name: "HKDF",
              hash: "SHA-256",
              salt: new TextEncoder().encode(
                `${VAULT_KEY_DERIVATION_DOMAIN}\0${VAULT_V2_PROTOCOL_VERSION}\0${vaultId.toLowerCase()}`,
              ),
              info: new TextEncoder().encode(
                `${VAULT_KEY_DERIVATION_DOMAIN}\0v2\0${purpose}`,
              ),
            },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          ),
        );
      cache.set(purpose, key);
    }
    return key;
  };
};

export const createVaultV2MessageId = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = requireCrypto().getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// ------------------------------------------------------------------ seal / open

export const sealVaultV2 = async (
  keys: VaultV2Keys,
  context: VaultEnvelopeContextV2,
  plaintext: Uint8Array,
): Promise<VaultEnvelopeV2> => {
  assertContext(context as unknown as Record<string, unknown>);
  const crypto = requireCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeVaultEnvelopeAadV2(context),
      tagLength: 128,
    },
    await keys(context.purpose),
    plaintext as Uint8Array<ArrayBuffer>,
  );
  return {
    ...context,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
};

export const openVaultV2 = async (
  keys: VaultV2Keys,
  envelope: unknown,
): Promise<{ envelope: VaultEnvelopeV2; plaintext: Uint8Array }> => {
  assertVaultEnvelopeV2(envelope);
  const { iv, ciphertext, ...context } = envelope;
  try {
    const plaintext = await requireCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(iv),
        additionalData: encodeVaultEnvelopeAadV2(context),
        tagLength: 128,
      },
      await keys(envelope.purpose),
      base64UrlToBytes(ciphertext),
    );
    return { envelope, plaintext: new Uint8Array(plaintext) };
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault ciphertext authentication failed.",
    );
  }
};

// ------------------------------------------------------------------ inner messages

export type SyncUpdateV2 = {
  kind: "sync.update";
  updateId: string;
  authorActorId: string;
  authorClock: number;
  /** state vector the author had before this batch (gap detection, S3) */
  baseStateVector: string;
  /** one merged Yjs update (base64url) */
  updates: string[];
  baseGeneration: number;
};
export type SyncContextV2 = {
  kind: "sync.context";
  stateVector: string;
  lastKnownGeneration: number;
};
export type SnapshotRequestV2 = {
  kind: "sync.snapshot-request";
  reason: "gap" | "join" | "decrypt-failed";
  stateVector: string;
};
export type SyncSnapshotV2 = {
  kind: "sync.snapshot";
  snapshotId: string;
  authorActorId: string;
  authorClock: number;
  generation: number;
  stateVector: string;
  /** full Yjs state (base64url) */
  state: string;
};
export type PresenceV2 = { kind: "presence"; payload: unknown };

export type VaultV2Inner =
  | SyncUpdateV2
  | SyncContextV2
  | SnapshotRequestV2
  | SyncSnapshotV2
  | PresenceV2;

const KIND_OF: Readonly<Record<VaultV2MessageType, VaultV2Inner["kind"]>> = {
  "sync.update": "sync.update",
  "sync.context": "sync.context",
  "sync.snapshot-request": "sync.snapshot-request",
  "snapshot.scene": "sync.snapshot",
  "presence.ephemeral": "presence",
};

const isB64 = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]*$/.test(value);

/** inner shape must match the (authenticated) outer messageType */
export function assertVaultV2Inner(
  messageType: VaultV2MessageType,
  value: unknown,
): asserts value is VaultV2Inner {
  const fail = (): never => {
    throw new VaultError(
      "VAULT_MESSAGE_TYPE_UNSUPPORTED",
      "Invalid v2 inner message.",
    );
  };
  if (!value || typeof value !== "object") {
    fail();
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== KIND_OF[messageType]) {
    fail();
  }
  switch (record.kind) {
    case "sync.update":
      if (
        typeof record.updateId !== "string" ||
        typeof record.authorActorId !== "string" ||
        !isInt(record.authorClock, 0) ||
        !isB64(record.baseStateVector) ||
        !Array.isArray(record.updates) ||
        !record.updates.every(isB64) ||
        !isInt(record.baseGeneration, 0)
      ) {
        fail();
      }
      break;
    case "sync.context":
      if (!isB64(record.stateVector) || !isInt(record.lastKnownGeneration, 0)) {
        fail();
      }
      break;
    case "sync.snapshot-request":
      if (
        !["gap", "join", "decrypt-failed"].includes(record.reason as string) ||
        !isB64(record.stateVector)
      ) {
        fail();
      }
      break;
    case "sync.snapshot":
      if (
        typeof record.snapshotId !== "string" ||
        typeof record.authorActorId !== "string" ||
        !isInt(record.authorClock, 0) ||
        !isInt(record.generation, 0) ||
        !isB64(record.stateVector) ||
        !isB64(record.state)
      ) {
        fail();
      }
      break;
    case "presence":
      break;
  }
}

// ------------------------------------------------------------------ chunking (S5)

type ChunkFrame = { group: string; part: string };

/** seals one inner message, split into ≤ 64 chunks of ≤ 480 000 raw bytes */
export const sealVaultV2Message = async (
  keys: VaultV2Keys,
  base: Omit<
    VaultEnvelopeContextV2,
    "messageId" | "chunkIndex" | "chunkCount" | "purpose"
  >,
  inner: VaultV2Inner,
): Promise<VaultEnvelopeV2[]> => {
  const purpose = VAULT_V2_PURPOSE_OF[base.messageType];
  const bytes = new TextEncoder().encode(JSON.stringify(inner));
  if (bytes.byteLength <= VAULT_V2_CHUNK_RAW_BYTES) {
    return [
      await sealVaultV2(
        keys,
        {
          ...base,
          purpose,
          messageId: createVaultV2MessageId(),
          chunkIndex: 0,
          chunkCount: 1,
        },
        bytes,
      ),
    ];
  }
  const chunkCount = Math.ceil(bytes.byteLength / VAULT_V2_CHUNK_RAW_BYTES);
  if (chunkCount > VAULT_V2_MAX_CHUNKS) {
    throw new VaultError(
      "VAULT_PAYLOAD_TOO_LARGE",
      "Vault v2 message exceeds 64 chunks.",
    );
  }
  const group = createVaultV2MessageId();
  const out: VaultEnvelopeV2[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const slice = bytes.subarray(
      chunkIndex * VAULT_V2_CHUNK_RAW_BYTES,
      (chunkIndex + 1) * VAULT_V2_CHUNK_RAW_BYTES,
    );
    const frame: ChunkFrame = { group, part: bytesToBase64Url(slice) };
    out.push(
      await sealVaultV2(
        keys,
        {
          ...base,
          purpose,
          messageId: createVaultV2MessageId(),
          chunkIndex,
          chunkCount,
        },
        new TextEncoder().encode(JSON.stringify(frame)),
      ),
    );
  }
  return out;
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new VaultError(
      "VAULT_DECRYPT_FAILED",
      "Vault plaintext is not valid JSON.",
    );
  }
};

type Pending = {
  messageType: VaultV2MessageType;
  generation: number;
  chunkCount: number;
  parts: Map<number, string>;
  startedAt: number;
};

/**
 * Collects chunks until a group is complete (N10, N11). Nothing of a group is
 * returned before all chunks arrived; incomplete groups expire.
 */
export class VaultV2Reassembler {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** returns the inner message when complete, `null` while waiting */
  accept(
    envelope: VaultEnvelopeV2,
    plaintext: Uint8Array,
  ): VaultV2Inner | null {
    const decoded = parseJson(plaintext);
    if (envelope.chunkCount === 1) {
      assertVaultV2Inner(envelope.messageType, decoded);
      return decoded;
    }
    const frame = decoded as ChunkFrame;
    if (!frame || typeof frame.group !== "string" || !isB64(frame.part)) {
      throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid chunk frame.");
    }
    let group = this.pending.get(frame.group);
    if (!group) {
      group = {
        messageType: envelope.messageType,
        generation: envelope.generation,
        chunkCount: envelope.chunkCount,
        parts: new Map(),
        startedAt: this.now(),
      };
      this.pending.set(frame.group, group);
    }
    if (
      group.messageType !== envelope.messageType ||
      group.generation !== envelope.generation ||
      group.chunkCount !== envelope.chunkCount
    ) {
      this.pending.delete(frame.group);
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Inconsistent chunk group.",
      );
    }
    const existing = group.parts.get(envelope.chunkIndex);
    if (existing !== undefined) {
      if (existing === frame.part) {
        return null; // exact duplicate (retry)
      }
      this.pending.delete(frame.group);
      throw new VaultError(
        "VAULT_REPLAY_REJECTED",
        "Conflicting duplicate chunk.",
      );
    }
    group.parts.set(envelope.chunkIndex, frame.part);
    if (group.parts.size < group.chunkCount) {
      return null;
    }
    this.pending.delete(frame.group);
    const slices = [...Array(group.chunkCount).keys()].map((index) =>
      base64UrlToBytes(group!.parts.get(index)!),
    );
    const total = slices.reduce((sum, slice) => sum + slice.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const slice of slices) {
      joined.set(slice, offset);
      offset += slice.byteLength;
    }
    const inner = parseJson(joined);
    assertVaultV2Inner(envelope.messageType, inner);
    return inner;
  }

  /** drops groups older than the timeout; returns how many expired */
  expire(): number {
    let expired = 0;
    for (const [group, pending] of this.pending) {
      if (this.now() - pending.startedAt > this.timeoutMs) {
        this.pending.delete(group);
        expired += 1;
      }
    }
    return expired;
  }

  get pendingGroups() {
    return this.pending.size;
  }
}

export const toB64 = bytesToBase64Url;
export const fromB64 = base64UrlToBytes;
