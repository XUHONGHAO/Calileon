import type { SocketId } from "@excalidraw/excalidraw/types";

import {
  assertVaultAdmissionToken,
  assertVaultCapabilityResolution,
} from "./admission";
import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultCapabilityControlPlane } from "./controlPlane";
import { isVaultErrorCode, VaultError } from "./errors";
import { assertVaultEncryptedEnvelopeV1 } from "./protocol";
import { VaultRealtimeSession } from "./realtime";
import { isVaultClientSession, readVaultSessionSecrets } from "./session";
import { VAULT_SOCKET_EVENTS } from "./backendContract";

import type {
  VaultCapabilityResolution,
  VaultRealtimeEncryptedEnvelopeV1,
} from "./types";
import type {
  VaultSocketBroadcast,
  VaultSocketJoinRequest,
} from "./backendContract";
import type { VaultRealtimeDecodedMessage } from "./realtime";
import type { VaultClientSession } from "./session";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROADCAST_KEYS = [
  "sourceSocketId",
  "admittedSenderSessionId",
  "envelope",
] as const;
const JOIN_SUCCESS_KEYS = ["ok", "resolution"] as const;
const JOIN_FAILURE_KEYS = ["ok", "code"] as const;
const DEFAULT_JOIN_TIMEOUT_MS = 5_000;

export interface VaultRealtimeTransportSocket {
  on(
    event: string,
    listener: (...args: any[]) => void,
  ): VaultRealtimeTransportSocket;
  off(
    event: string,
    listener: (...args: any[]) => void,
  ): VaultRealtimeTransportSocket;
  emit(event: string, ...args: any[]): unknown;
  close(): void;
}

export interface VaultRealtimeTransportCallbacks {
  onMessage(message: VaultRealtimeDecodedMessage): void | Promise<void>;
  onError?(error: VaultError): void;
  onDisconnect?(error: VaultError): void;
  onReconnect?(): void | Promise<void>;
  onTeardown?(error: VaultError): void;
}

type VaultSocketJoinAck =
  | { ok: true; resolution: VaultCapabilityResolution }
  | { ok: false; code: VaultError["code"] };

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const toVaultError = (error: unknown, fallback: VaultError["code"]) =>
  error instanceof VaultError
    ? error
    : new VaultError(fallback, "Vault realtime transport failed.");

const parseVaultSocketJoinAck = (value: unknown): VaultSocketJoinAck => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault socket admission response is invalid.",
    );
  }
  const ack = value as Record<string, unknown>;
  if (ack.ok === false && hasExactKeys(ack, JOIN_FAILURE_KEYS)) {
    if (!isVaultErrorCode(ack.code)) {
      throw new VaultError(
        "VAULT_CAPABILITY_INVALID",
        "Vault socket admission error is invalid.",
      );
    }
    return { ok: false, code: ack.code };
  }
  if (ack.ok !== true || !hasExactKeys(ack, JOIN_SUCCESS_KEYS)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault socket admission response is invalid.",
    );
  }
  return { ok: true, resolution: ack.resolution as VaultCapabilityResolution };
};

const assertResolutionMatchesSession = (
  session: VaultClientSession,
  resolution: VaultCapabilityResolution,
) => {
  const admission = session.admission;
  if (
    resolution.vaultId !== admission.vaultId ||
    resolution.invitationId !== admission.invitationId ||
    resolution.role !== admission.role ||
    resolution.authorizationVersion !== admission.authorizationVersion ||
    resolution.activeRoomId !== admission.activeRoomId ||
    resolution.snapshotGeneration !== session.snapshotGeneration ||
    resolution.expiresAt !== admission.expiresAt
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault socket admission changed during session open.",
    );
  }
};

export function assertVaultIncomingSocketBroadcast(
  vaultId: string,
  value: unknown,
): asserts value is VaultSocketBroadcast {
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
    typeof broadcast.admittedSenderSessionId !== "string" ||
    !UUID_V4_RE.test(broadcast.admittedSenderSessionId)
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault socket broadcast identity is invalid.",
    );
  }
  assertVaultEncryptedEnvelopeV1(broadcast.envelope);
  const envelope = broadcast.envelope as VaultRealtimeEncryptedEnvelopeV1;
  if (
    envelope.purpose !== "realtime" ||
    envelope.vaultId !== vaultId ||
    envelope.senderSessionId !== broadcast.admittedSenderSessionId
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault socket broadcast binding is invalid.",
    );
  }
}

export class VaultRealtimeTransport {
  readonly realtimeSession: VaultRealtimeSession;

  private readonly clientSession: VaultClientSession;
  private readonly socket: VaultRealtimeTransportSocket;
  private readonly callbacks: VaultRealtimeTransportCallbacks;
  private readonly joinTimeoutMs: number;
  private controlPlane: VaultCapabilityControlPlane | null = null;
  private receiveQueue: Promise<void> = Promise.resolve();
  private joined = false;
  private closed = false;
  private reconnectPending = false;
  private teardownError: VaultError | null = null;

  private readonly onSocketDisconnect = () => {
    if (this.closed || !this.joined) {
      return;
    }
    this.joined = false;
    this.reconnectPending = true;
    this.controlPlane?.dispose();
    this.controlPlane = null;
    this.callbacks.onDisconnect?.(
      new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault room connection was interrupted.",
      ),
    );
  };

  private readonly onSocketConnect = () => {
    if (this.closed || !this.reconnectPending) {
      return;
    }
    this.reconnectPending = false;
    void Promise.resolve(this.callbacks.onReconnect?.())
      .catch((error) => {
        this.callbacks.onError?.(
          toVaultError(error, "VAULT_PERSISTENCE_UNAVAILABLE"),
        );
      })
      .finally(() => {
        // A reconnect must reopen from the latest encrypted snapshot. The old
        // socket is never silently re-admitted because it may have missed
        // durable changes while the room was unavailable.
        this.dispose();
      });
  };

  private readonly onReliableBroadcast = (value: unknown) => {
    this.queueIncomingBroadcast(value);
  };

  private readonly onVolatileBroadcast = (value: unknown) => {
    this.queueIncomingBroadcast(value);
  };

  constructor(options: {
    clientSession: VaultClientSession;
    socket: VaultRealtimeTransportSocket;
    callbacks: VaultRealtimeTransportCallbacks;
    joinTimeoutMs?: number;
  }) {
    if (!isVaultClientSession(options.clientSession)) {
      throw new VaultError(
        "VAULT_CAPABILITY_INVALID",
        "Vault client session proof is missing or invalid.",
      );
    }
    assertVaultAdmissionToken(options.clientSession.admission);
    if (
      options.joinTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.joinTimeoutMs) ||
        options.joinTimeoutMs < 1)
    ) {
      throw new VaultError(
        "VAULT_INTERNAL",
        "Vault socket join timeout is invalid.",
      );
    }
    this.clientSession = options.clientSession;
    this.socket = options.socket;
    this.callbacks = options.callbacks;
    this.joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;

    const { rootKey } = readVaultSessionSecrets(this.clientSession);
    this.realtimeSession = new VaultRealtimeSession({
      vaultId: this.clientSession.vaultId,
      rootKey,
      role: this.clientSession.role,
      senderSessionId: this.clientSession.admission.senderSessionId,
    });
  }

  connect = async () => {
    if (this.closed || this.joined) {
      throw new VaultError(
        "VAULT_CAPABILITY_INVALID",
        "Vault realtime transport cannot be joined twice.",
      );
    }
    assertVaultAdmissionToken(this.clientSession.admission);
    const { invitationCapability } = readVaultSessionSecrets(
      this.clientSession,
    );
    const request: VaultSocketJoinRequest = {
      protocolVersion: VAULT_PROTOCOL_VERSION,
      vaultId: this.clientSession.vaultId,
      invitationCapability,
      senderSessionId: this.clientSession.admission.senderSessionId,
    };

    this.socket.on("disconnect", this.onSocketDisconnect);
    this.socket.on("connect", this.onSocketConnect);
    this.socket.on(VAULT_SOCKET_EVENTS.server, this.onReliableBroadcast);
    this.socket.on(
      VAULT_SOCKET_EVENTS.serverVolatile,
      this.onVolatileBroadcast,
    );

    return await new Promise<VaultRealtimeTransport>((resolve, reject) => {
      let settled = false;
      const finish = (error?: VaultError) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        if (error) {
          this.teardownOnce(error);
          reject(error);
        } else {
          resolve(this);
        }
      };
      const timeout = globalThis.setTimeout(
        () =>
          finish(
            new VaultError(
              "VAULT_PERSISTENCE_UNAVAILABLE",
              "Vault socket admission timed out.",
            ),
          ),
        this.joinTimeoutMs,
      );

      this.socket.emit(VAULT_SOCKET_EVENTS.join, request, (value: unknown) => {
        try {
          const ack = parseVaultSocketJoinAck(value);
          if (!ack.ok) {
            throw new VaultError(
              ack.code,
              "Vault socket admission was rejected.",
            );
          }
          // The server parser is repeated client-side so an injected or stale
          // ack cannot silently replace the persistence admission.
          assertVaultCapabilityResolution(ack.resolution);
          assertVaultAdmissionToken(this.clientSession.admission);
          assertResolutionMatchesSession(this.clientSession, ack.resolution);
          this.controlPlane = new VaultCapabilityControlPlane({
            admission: this.clientSession.admission,
            socket: this.socket,
            teardown: this.teardownOnce,
          });
          if (this.closed) {
            throw (
              this.teardownError ??
              new VaultError(
                "VAULT_CAPABILITY_EXPIRED",
                "Vault admission expired during socket join.",
              )
            );
          }
          this.joined = true;
          finish();
        } catch (error) {
          finish(toVaultError(error, "VAULT_CAPABILITY_INVALID"));
        }
      });
    });
  };

  dispose = () => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanup();
    this.realtimeSession.destroy();
    this.socket.close();
  };

  private queueIncomingBroadcast = (value: unknown) => {
    if (!this.joined || this.closed) {
      return;
    }
    const task = this.receiveQueue.then(async () => {
      assertVaultIncomingSocketBroadcast(this.clientSession.vaultId, value);
      const decoded = await this.realtimeSession.decrypt(value.envelope, {
        sourceSocketId: value.sourceSocketId as SocketId,
        admittedSenderSessionId: value.admittedSenderSessionId,
      });
      if (!this.closed) {
        await this.callbacks.onMessage(decoded);
      }
    });
    this.receiveQueue = task.catch((error) => {
      if (!this.closed) {
        this.callbacks.onError?.(toVaultError(error, "VAULT_ENVELOPE_INVALID"));
      }
    });
  };

  private readonly teardownOnce = (error: VaultError) => {
    if (this.closed) {
      return;
    }
    this.teardownError = error;
    this.closed = true;
    this.cleanup();
    this.realtimeSession.destroy();
    this.socket.close();
    this.callbacks.onTeardown?.(error);
  };

  private cleanup = () => {
    this.socket.off("disconnect", this.onSocketDisconnect);
    this.socket.off("connect", this.onSocketConnect);
    this.socket.off(VAULT_SOCKET_EVENTS.server, this.onReliableBroadcast);
    this.socket.off(
      VAULT_SOCKET_EVENTS.serverVolatile,
      this.onVolatileBroadcast,
    );
    this.controlPlane?.dispose();
    this.controlPlane = null;
  };
}
