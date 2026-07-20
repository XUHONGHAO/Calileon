import { assertVaultAdmissionIssuedToken } from "./admission";
import { VAULT_SOCKET_EVENTS } from "./backendContract";
import { VaultError } from "./errors";

import type { VaultAdmission } from "./admission";
import type { VaultCapabilityDisconnectNotice } from "./backendContract";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTICE_KEYS = [
  "vaultId",
  "invitationId",
  "authorizationVersion",
  "reason",
] as const;
const REVOKED_REASONS = ["revoked", "vault-revoked", "vault-deleted"] as const;
const MAX_TIMER_DELAY = 2_147_483_647;

export interface VaultControlPlaneSocket {
  on(
    event: string,
    listener: (notice: unknown) => void,
  ): VaultControlPlaneSocket;
  off(
    event: string,
    listener: (notice: unknown) => void,
  ): VaultControlPlaneSocket;
}

export interface VaultControlPlaneClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VaultControlPlaneOptions {
  admission: VaultAdmission;
  socket: VaultControlPlaneSocket;
  teardown(error: VaultError): void;
  clock?: VaultControlPlaneClock;
}

const systemClock: VaultControlPlaneClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

export function assertVaultCapabilityDisconnectNotice(
  value: unknown,
): asserts value is VaultCapabilityDisconnectNotice {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_CAPABILITY_REVOKED",
      "Vault capability disconnect notice is invalid.",
    );
  }
  const notice = value as Record<string, unknown>;
  if (
    !hasExactKeys(notice, NOTICE_KEYS) ||
    typeof notice.vaultId !== "string" ||
    !UUID_RE.test(notice.vaultId) ||
    typeof notice.invitationId !== "string" ||
    !UUID_RE.test(notice.invitationId) ||
    typeof notice.authorizationVersion !== "number" ||
    !Number.isSafeInteger(notice.authorizationVersion) ||
    notice.authorizationVersion < 1 ||
    (notice.reason !== "expired" &&
      !REVOKED_REASONS.includes(
        notice.reason as typeof REVOKED_REASONS[number],
      ))
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_REVOKED",
      "Vault capability disconnect notice is invalid.",
    );
  }
}

const assertNoticeMatchesAdmission = (
  admission: VaultAdmission,
  notice: VaultCapabilityDisconnectNotice,
) => {
  if (
    notice.vaultId !== admission.vaultId ||
    notice.invitationId !== admission.invitationId ||
    notice.authorizationVersion < admission.authorizationVersion ||
    (notice.reason === "revoked" &&
      notice.authorizationVersion <= admission.authorizationVersion)
  ) {
    throw new VaultError(
      notice.reason === "expired"
        ? "VAULT_CAPABILITY_EXPIRED"
        : "VAULT_CAPABILITY_REVOKED",
      "Vault disconnect notice does not match the active admission.",
    );
  }
};

export class VaultCapabilityControlPlane {
  private readonly admission: VaultAdmission;
  private readonly socket: VaultControlPlaneSocket;
  private readonly teardown: (error: VaultError) => void;
  private readonly clock: VaultControlPlaneClock;
  private expiryTimer: unknown = null;
  private closed = false;

  private readonly onRevoked = (value: unknown) => {
    this.handleNotice(value, "revoked");
  };

  private readonly onExpired = (value: unknown) => {
    this.handleNotice(value, "expired");
  };

  constructor(options: VaultControlPlaneOptions) {
    assertVaultAdmissionIssuedToken(options.admission);
    this.admission = options.admission;
    this.socket = options.socket;
    this.teardown = options.teardown;
    this.clock = options.clock ?? systemClock;

    if (
      this.admission.expiresAt !== null &&
      this.admission.expiresAt <= this.clock.now()
    ) {
      this.teardownOnce(
        new VaultError(
          "VAULT_CAPABILITY_EXPIRED",
          "Vault admission has expired.",
        ),
      );
      return;
    }
    this.socket.on(VAULT_SOCKET_EVENTS.capabilityRevoked, this.onRevoked);
    this.socket.on(VAULT_SOCKET_EVENTS.capabilityExpired, this.onExpired);
    this.scheduleExpiry();
  }

  dispose = () => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanup();
  };

  private handleNotice = (value: unknown, channel: "revoked" | "expired") => {
    if (this.closed) {
      return;
    }
    try {
      assertVaultCapabilityDisconnectNotice(value);
      if (
        (channel === "expired" && value.reason !== "expired") ||
        (channel === "revoked" && value.reason === "expired")
      ) {
        throw new VaultError(
          channel === "expired"
            ? "VAULT_CAPABILITY_EXPIRED"
            : "VAULT_CAPABILITY_REVOKED",
          "Vault disconnect notice arrived on the wrong control channel.",
        );
      }
      assertNoticeMatchesAdmission(this.admission, value);
      this.teardownOnce(
        new VaultError(
          value.reason === "expired"
            ? "VAULT_CAPABILITY_EXPIRED"
            : "VAULT_CAPABILITY_REVOKED",
          "Vault capability is no longer admitted.",
        ),
      );
    } catch (error) {
      this.teardownOnce(
        new VaultError(
          channel === "expired"
            ? "VAULT_CAPABILITY_EXPIRED"
            : "VAULT_CAPABILITY_REVOKED",
          error instanceof VaultError
            ? error.message
            : "Vault control-plane validation failed.",
        ),
      );
    }
  };

  private scheduleExpiry = () => {
    if (this.admission.expiresAt === null || this.closed) {
      return;
    }
    const remaining = this.admission.expiresAt - this.clock.now();
    if (remaining <= 0) {
      this.teardownOnce(
        new VaultError(
          "VAULT_CAPABILITY_EXPIRED",
          "Vault admission has expired.",
        ),
      );
      return;
    }
    this.expiryTimer = this.clock.setTimeout(() => {
      this.expiryTimer = null;
      this.scheduleExpiry();
    }, Math.min(remaining, MAX_TIMER_DELAY));
  };

  private teardownOnce = (error: VaultError) => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanup();
    this.teardown(error);
  };

  private cleanup = () => {
    this.socket.off(VAULT_SOCKET_EVENTS.capabilityRevoked, this.onRevoked);
    this.socket.off(VAULT_SOCKET_EVENTS.capabilityExpired, this.onExpired);
    if (this.expiryTimer !== null) {
      this.clock.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  };
}
