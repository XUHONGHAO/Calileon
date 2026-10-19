/**
 * Vault v2 (P4c) socket.io transport (W2 S-1…S-5). Implements the sync
 * engine's `VaultV2Transport`.
 *
 * - join: `vault:join` with `{ protocolVersion: 2, vaultId,
 *   invitationCapability }` (no sender session: v2 binds authorship inside the
 *   AEAD, S-3); the ack resolution must be a v2 resolution of this Vault;
 * - send: `vault:server` (reliable, acked) or `vault:server-volatile`
 *   (presence, fire-and-forget) with `(roomId, envelope)`;
 * - receive: the room relays `{ envelope }` only (S-4); the frame is checked
 *   structurally here, authenticity is the engine's `openVaultV2`;
 * - revoke/expire notices and rejected acks for authorization errors block
 *   the session for good; plain disconnects only mark it offline, the caller
 *   re-joins via `join()` and then `engine.onReconnect()`.
 */
import { VAULT_SOCKET_EVENTS } from "../backendContract";
import { isVaultErrorCode, VaultError } from "../errors";

import { VAULT_V2_PROTOCOL_VERSION, assertVaultEnvelopeV2 } from "./protocol";

import type { VaultErrorCode } from "../errors";
import type { VaultEnvelopeV2 } from "./protocol";
import type { VaultV2Role, VaultV2Transport } from "./syncEngine";

export const VAULT_V2_JOIN_TIMEOUT_MS = 8_000;
export const VAULT_V2_SEND_TIMEOUT_MS = 10_000;

export interface VaultV2Socket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  readonly connected: boolean;
}

export type VaultV2Admission = {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly role: VaultV2Role;
  readonly authorizationVersion: number;
  readonly activeRoomId: string;
  readonly snapshotGeneration: number;
  readonly expiresAt: number | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const RESOLUTION_KEYS = [
  "vaultId",
  "invitationId",
  "role",
  "authorizationVersion",
  "activeRoomId",
  "snapshotGeneration",
  "expiresAt",
  "protocolVersion",
] as const;
const NOTICE_KEYS = [
  "vaultId",
  "invitationId",
  "authorizationVersion",
  "reason",
] as const;

/** ack codes after which re-joining with the same capability is pointless */
const BLOCKING_CODES = new Set<VaultErrorCode>([
  "VAULT_CAPABILITY_INVALID",
  "VAULT_CAPABILITY_FORBIDDEN",
  "VAULT_CAPABILITY_EXPIRED",
  "VAULT_CAPABILITY_REVOKED",
  "VAULT_NOT_FOUND",
  "VAULT_NOT_ACTIVE",
  "VAULT_PROTOCOL_UNSUPPORTED",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const isSafeIntegerAtLeast = (value: unknown, minimum: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const invalid = (message: string) =>
  new VaultError("VAULT_CAPABILITY_INVALID", message);

export const parseVaultV2Admission = (
  value: unknown,
  vaultId: string,
  now = Date.now(),
): VaultV2Admission => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RESOLUTION_KEYS) ||
    value.protocolVersion !== VAULT_V2_PROTOCOL_VERSION ||
    typeof value.vaultId !== "string" ||
    value.vaultId.toLowerCase() !== vaultId.toLowerCase() ||
    typeof value.invitationId !== "string" ||
    !UUID_RE.test(value.invitationId) ||
    (value.role !== "viewer" && value.role !== "editor") ||
    !isSafeIntegerAtLeast(value.authorizationVersion, 1) ||
    typeof value.activeRoomId !== "string" ||
    !ACTIVE_ROOM_ID_RE.test(value.activeRoomId) ||
    !isSafeIntegerAtLeast(value.snapshotGeneration, 0) ||
    (value.expiresAt !== null && !isSafeIntegerAtLeast(value.expiresAt, 0))
  ) {
    throw invalid("Vault v2 admission is invalid.");
  }
  if (value.expiresAt !== null && (value.expiresAt as number) <= now) {
    throw new VaultError(
      "VAULT_CAPABILITY_EXPIRED",
      "Vault capability has expired.",
    );
  }
  return Object.freeze({
    vaultId: value.vaultId,
    invitationId: value.invitationId,
    role: value.role,
    authorizationVersion: value.authorizationVersion as number,
    activeRoomId: value.activeRoomId,
    snapshotGeneration: value.snapshotGeneration as number,
    expiresAt: value.expiresAt as number | null,
  });
};

const parseAck = (
  value: unknown,
): { ok: true } | { ok: false; code: VaultErrorCode } => {
  if (isRecord(value) && value.ok === false && isVaultErrorCode(value.code)) {
    return { ok: false, code: value.code };
  }
  if (isRecord(value) && value.ok === true) {
    return { ok: true };
  }
  return { ok: false, code: "VAULT_INTERNAL" };
};

export class VaultV2SocketTransport implements VaultV2Transport {
  private admission: VaultV2Admission | null = null;
  private readonly handlers = new Set<(envelope: unknown) => void>();
  private blocked: VaultError | null = null;
  private disposed = false;

  constructor(
    private readonly options: {
      socket: VaultV2Socket;
      vaultId: string;
      invitationCapability: string;
      onBlocked?: (error: VaultError) => void;
      onDisconnect?: () => void;
      joinTimeoutMs?: number;
      sendTimeoutMs?: number;
      now?: () => number;
    },
  ) {
    const { socket } = options;
    socket.on(VAULT_SOCKET_EVENTS.server, this.onRelay);
    socket.on(VAULT_SOCKET_EVENTS.capabilityRevoked, this.onRevoked);
    socket.on(VAULT_SOCKET_EVENTS.capabilityExpired, this.onExpired);
    socket.on("disconnect", this.onSocketDisconnect);
  }

  get currentAdmission() {
    return this.admission;
  }

  isConnected = () =>
    !this.disposed &&
    !this.blocked &&
    this.admission !== null &&
    this.options.socket.connected;

  /** (re-)admits this socket; call after every socket.io (re)connect */
  join = (): Promise<VaultV2Admission> => {
    if (this.disposed || this.blocked) {
      return Promise.reject(
        this.blocked ??
          new VaultError("VAULT_INTERNAL", "Vault v2 transport disposed."),
      );
    }
    this.admission = null;
    const request = {
      protocolVersion: VAULT_V2_PROTOCOL_VERSION,
      vaultId: this.options.vaultId,
      invitationCapability: this.options.invitationCapability,
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = globalThis.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new VaultError(
              "VAULT_PERSISTENCE_UNAVAILABLE",
              "Vault socket admission timed out.",
            ),
          );
        }
      }, this.options.joinTimeoutMs ?? VAULT_V2_JOIN_TIMEOUT_MS);
      this.options.socket.emit(
        VAULT_SOCKET_EVENTS.join,
        request,
        (value: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          globalThis.clearTimeout(timeout);
          try {
            if (isRecord(value) && value.ok === false) {
              const code = isVaultErrorCode(value.code)
                ? value.code
                : "VAULT_CAPABILITY_INVALID";
              throw new VaultError(
                code,
                "Vault socket admission was rejected.",
              );
            }
            if (
              !isRecord(value) ||
              value.ok !== true ||
              !hasExactKeys(value, ["ok", "resolution"])
            ) {
              throw invalid("Vault socket admission response is invalid.");
            }
            const admission = parseVaultV2Admission(
              value.resolution,
              this.options.vaultId,
              (this.options.now ?? Date.now)(),
            );
            if (this.disposed || this.blocked) {
              throw (
                this.blocked ??
                new VaultError("VAULT_INTERNAL", "Vault v2 transport disposed.")
              );
            }
            this.admission = admission;
            resolve(admission);
          } catch (error) {
            const vaultError =
              error instanceof VaultError
                ? error
                : invalid("Vault socket admission failed.");
            if (BLOCKING_CODES.has(vaultError.code)) {
              this.block(vaultError);
            }
            reject(vaultError);
          }
        },
      );
    });
  };

  send = async (
    envelopes: readonly VaultEnvelopeV2[],
    { volatile }: { volatile: boolean },
  ) => {
    const admission = this.admission;
    if (!admission || !this.isConnected()) {
      throw new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault realtime link is not connected.",
      );
    }
    for (const envelope of envelopes) {
      if (volatile) {
        this.options.socket.emit(
          VAULT_SOCKET_EVENTS.serverVolatile,
          admission.activeRoomId,
          envelope,
        );
      } else {
        await this.sendReliable(admission.activeRoomId, envelope);
      }
    }
  };

  private sendReliable(roomId: string, envelope: VaultEnvelopeV2) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = globalThis.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new VaultError(
              "VAULT_PERSISTENCE_UNAVAILABLE",
              "Vault relay did not acknowledge.",
            ),
          );
        }
      }, this.options.sendTimeoutMs ?? VAULT_V2_SEND_TIMEOUT_MS);
      this.options.socket.emit(
        VAULT_SOCKET_EVENTS.server,
        roomId,
        envelope,
        (value: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          globalThis.clearTimeout(timeout);
          const ack = parseAck(value);
          if (ack.ok) {
            resolve();
            return;
          }
          const error = new VaultError(ack.code, "Vault relay rejected.");
          if (BLOCKING_CODES.has(ack.code)) {
            this.block(error);
          }
          reject(error);
        },
      );
    });
  }

  onEnvelope = (handler: (envelope: unknown) => void) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  };

  dispose = () => {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.admission = null;
    this.handlers.clear();
    const { socket } = this.options;
    socket.off(VAULT_SOCKET_EVENTS.server, this.onRelay);
    socket.off(VAULT_SOCKET_EVENTS.capabilityRevoked, this.onRevoked);
    socket.off(VAULT_SOCKET_EVENTS.capabilityExpired, this.onExpired);
    socket.off("disconnect", this.onSocketDisconnect);
  };

  private block(error: VaultError) {
    if (this.blocked || this.disposed) {
      return;
    }
    this.blocked = error;
    this.admission = null;
    this.options.onBlocked?.(error);
  }

  private readonly onRelay = (frame: unknown) => {
    if (!this.admission || this.disposed) {
      return;
    }
    // S-4: exactly `{ envelope }`; anything else is not from a v2 room
    if (!isRecord(frame) || !hasExactKeys(frame, ["envelope"])) {
      return;
    }
    try {
      assertVaultEnvelopeV2(frame.envelope);
    } catch {
      return;
    }
    if (
      frame.envelope.vaultId.toLowerCase() !==
        this.admission.vaultId.toLowerCase() ||
      frame.envelope.roomId !== this.admission.activeRoomId
    ) {
      return;
    }
    for (const handler of this.handlers) {
      handler(frame.envelope);
    }
  };

  private onNotice(value: unknown, reason: "revoked" | "expired") {
    const admission = this.admission;
    if (
      !admission ||
      !isRecord(value) ||
      !hasExactKeys(value, NOTICE_KEYS) ||
      value.vaultId !== admission.vaultId ||
      value.reason !== reason ||
      // a Vault-wide revoke carries the admitted invitation as well
      value.invitationId !== admission.invitationId
    ) {
      return;
    }
    this.block(
      new VaultError(
        reason === "expired"
          ? "VAULT_CAPABILITY_EXPIRED"
          : "VAULT_CAPABILITY_REVOKED",
        "Vault access ended.",
      ),
    );
  }

  private readonly onRevoked = (value: unknown) =>
    this.onNotice(value, "revoked");

  private readonly onExpired = (value: unknown) =>
    this.onNotice(value, "expired");

  private readonly onSocketDisconnect = () => {
    if (this.disposed) {
      return;
    }
    this.admission = null;
    this.options.onDisconnect?.();
  };
}
