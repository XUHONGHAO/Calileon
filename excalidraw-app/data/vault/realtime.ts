import type { SocketId } from "@excalidraw/excalidraw/types";

import { WS_SUBTYPES } from "../../app_constants";

import {
  canVaultRoleSendMessage,
  commitVaultRealtimeEnvelope,
  createVaultMessageId,
  createVaultReplayState,
  createVaultSenderSessionId,
  assertVaultRealtimeEnvelopeFresh,
} from "./protocol";
import { decryptVaultJson, encryptVaultJson } from "./crypto";
import { VaultError } from "./errors";

import type { SocketUpdateDataIncoming } from "../index";
import type {
  VaultMessageType,
  VaultRealtimeEncryptedEnvelopeV1,
  VaultRole,
} from "./types";
import type { VaultReplayState } from "./protocol";

export type VaultRealtimePayload = Exclude<
  SocketUpdateDataIncoming,
  { type: WS_SUBTYPES.INVALID_RESPONSE }
>;

export interface VaultRealtimeDecodedMessage {
  sourceSocketId: SocketId;
  payload: VaultRealtimePayload;
}

type VaultRealtimeMessageType = Extract<
  VaultMessageType,
  "realtime.content" | "realtime.presence"
>;

const VAULT_REALTIME_CONTENT_TYPES = new Set<WS_SUBTYPES>([
  WS_SUBTYPES.INIT,
  WS_SUBTYPES.UPDATE,
]);

const VAULT_REALTIME_PRESENCE_TYPES = new Set<WS_SUBTYPES>([
  WS_SUBTYPES.MOUSE_LOCATION,
  WS_SUBTYPES.IDLE_STATUS,
  WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
  WS_SUBTYPES.USER_FOLLOW_CHANGE,
]);

export const getVaultRealtimeMessageType = (
  payload: Pick<VaultRealtimePayload, "type">,
): VaultRealtimeMessageType => {
  if (VAULT_REALTIME_CONTENT_TYPES.has(payload.type)) {
    return "realtime.content";
  }
  if (VAULT_REALTIME_PRESENCE_TYPES.has(payload.type)) {
    return "realtime.presence";
  }
  throw new VaultError(
    "VAULT_MESSAGE_TYPE_UNSUPPORTED",
    "Unsupported Vault realtime payload.",
  );
};

export function assertVaultRealtimePayload(
  value: unknown,
): asserts value is VaultRealtimePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_MESSAGE_TYPE_UNSUPPORTED",
      "Invalid Vault realtime payload.",
    );
  }
  const payload = value as { type?: unknown; payload?: unknown };
  if (
    typeof payload.type !== "string" ||
    (!VAULT_REALTIME_CONTENT_TYPES.has(payload.type as WS_SUBTYPES) &&
      !VAULT_REALTIME_PRESENCE_TYPES.has(payload.type as WS_SUBTYPES)) ||
    !payload.payload ||
    typeof payload.payload !== "object" ||
    Array.isArray(payload.payload)
  ) {
    throw new VaultError(
      "VAULT_MESSAGE_TYPE_UNSUPPORTED",
      "Invalid Vault realtime payload.",
    );
  }
  if (
    (payload.type === WS_SUBTYPES.INIT ||
      payload.type === WS_SUBTYPES.UPDATE) &&
    !Array.isArray((payload.payload as { elements?: unknown }).elements)
  ) {
    throw new VaultError(
      "VAULT_MESSAGE_TYPE_UNSUPPORTED",
      "Invalid Vault scene payload.",
    );
  }
}

export class VaultRealtimeSession {
  readonly vaultId: string;
  readonly role: VaultRole;
  readonly senderSessionId: string;

  private rootKey: string | null;
  private nextSequence = 1;
  private readonly replayState: VaultReplayState;

  constructor(options: {
    vaultId: string;
    rootKey: string;
    role: VaultRole;
    senderSessionId?: string;
    replayWindowSize?: number;
  }) {
    this.vaultId = options.vaultId;
    this.rootKey = options.rootKey;
    this.role = options.role;
    this.senderSessionId =
      options.senderSessionId ?? createVaultSenderSessionId();
    this.replayState = createVaultReplayState(options.replayWindowSize);
  }

  encrypt = async (
    payload: VaultRealtimePayload,
  ): Promise<VaultRealtimeEncryptedEnvelopeV1> => {
    const rootKey = this.requireRootKey();
    assertVaultRealtimePayload(payload);
    const messageType = getVaultRealtimeMessageType(payload);
    if (!canVaultRoleSendMessage(this.role, messageType)) {
      throw new VaultError(
        "VAULT_CAPABILITY_FORBIDDEN",
        "Vault role cannot send this message type.",
      );
    }
    const sequence = this.nextSequence++;
    return (await encryptVaultJson(
      rootKey,
      {
        version: 1,
        vaultId: this.vaultId,
        purpose: "realtime",
        messageType,
        messageId: createVaultMessageId(),
        senderSessionId: this.senderSessionId,
        sequence,
      },
      payload,
    )) as VaultRealtimeEncryptedEnvelopeV1;
  };

  decrypt = async (
    envelope: VaultRealtimeEncryptedEnvelopeV1,
    transport: {
      sourceSocketId: SocketId;
      admittedSenderSessionId: string;
    },
  ): Promise<VaultRealtimeDecodedMessage> => {
    const rootKey = this.requireRootKey();
    if (envelope.senderSessionId !== transport.admittedSenderSessionId) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault sender session does not match the admission.",
      );
    }
    assertVaultRealtimeEnvelopeFresh(this.replayState, envelope);
    const payload = await decryptVaultJson<unknown>(rootKey, envelope);
    assertVaultRealtimePayload(payload);
    if (getVaultRealtimeMessageType(payload) !== envelope.messageType) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault inner payload does not match its outer message class.",
      );
    }
    if (
      (payload.type === WS_SUBTYPES.MOUSE_LOCATION ||
        payload.type === WS_SUBTYPES.IDLE_STATUS ||
        payload.type === WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS) &&
      payload.payload.socketId !== transport.sourceSocketId
    ) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault presence source does not match the admitted socket.",
      );
    }
    commitVaultRealtimeEnvelope(this.replayState, envelope);
    return { payload, sourceSocketId: transport.sourceSocketId };
  };

  destroy = () => {
    this.rootKey = null;
    this.nextSequence = 1;
    this.replayState.highestSequenceBySession.clear();
    this.replayState.seenMessageIds.clear();
    this.replayState.messageIdOrder.splice(0);
  };

  private requireRootKey = () => {
    if (!this.rootKey) {
      throw new VaultError("VAULT_KEY_INVALID", "Vault session is closed.");
    }
    return this.rootKey;
  };
}
