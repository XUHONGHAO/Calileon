import type { VaultErrorCode } from "./errors";

/**
 * Consolidated Vault recovery state. It is the single source of truth that the
 * UI reads so snapshot outbox, attachment tasks, connectivity and remote state
 * cannot disagree with each other.
 *
 * - `opening`: capability/protocol/root key still being validated.
 * - `recovering-local`: reading encrypted local snapshot, outbox and tasks.
 * - `local-restored`: local data is readable but not yet confirmed remotely.
 * - `syncing`: a drain is in flight.
 * - `synced`: snapshot and all attachments are confirmed remotely.
 * - `offline-local-safe`: encrypted local copy persisted, uploads deferred.
 * - `conflict`: local and remote branches cannot be merged automatically.
 * - `blocked`: fail-closed condition (revoked, tampered, wrong key, ...).
 * - `error`: recoverable operational failure without local persistence.
 */
export type VaultRecoveryState =
  | "opening"
  | "recovering-local"
  | "local-restored"
  | "syncing"
  | "synced"
  | "offline-local-safe"
  | "conflict"
  | "blocked"
  | "error";

export type VaultRecoveryUnsyncedReason =
  | "pending"
  | "offline"
  | "conflict"
  | "error";

export type VaultRecoveryLocalPersistence =
  | "not-persisted"
  | "local-persisted"
  | "remote-confirmed";

export interface VaultRecoverySnapshotState {
  readonly status: "synced" | "syncing" | "unsynced";
  readonly unsyncedReason: VaultRecoveryUnsyncedReason | null;
  readonly errorCode: VaultErrorCode | null;
  readonly localPersistence: VaultRecoveryLocalPersistence;
}

export interface VaultRecoveryAttachmentState {
  readonly pending: number;
  readonly failed: number;
}

export interface VaultRecoveryInput {
  readonly opening: boolean;
  readonly snapshot: VaultRecoverySnapshotState | null;
  readonly attachments: VaultRecoveryAttachmentState;
  readonly isOnline: boolean;
  readonly localStorageAvailable: boolean;
  readonly blockedCode: VaultErrorCode | null;
}

/**
 * Fail-closed codes that must never be presented as merely unsynced or
 * offline-safe: the local state itself is untrustworthy or unauthorized.
 */
const BLOCKED_CODES: ReadonlySet<VaultErrorCode> = new Set([
  "VAULT_KEY_INVALID",
  "VAULT_DECRYPT_FAILED",
  "VAULT_ENVELOPE_INVALID",
  "VAULT_CAPABILITY_REVOKED",
  "VAULT_CAPABILITY_EXPIRED",
  "VAULT_CAPABILITY_FORBIDDEN",
  "VAULT_CAPABILITY_INVALID",
  "VAULT_CAPABILITY_MISSING",
  "VAULT_PROTOCOL_UNSUPPORTED",
  "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
  "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
  "VAULT_PLAIN_FALLBACK_FORBIDDEN",
  "VAULT_ASSET_CONFLICT",
]);

export const isVaultRecoveryBlockedCode = (
  code: VaultErrorCode | null,
): boolean => code !== null && BLOCKED_CODES.has(code);

export const deriveVaultRecoveryState = (
  input: VaultRecoveryInput,
): VaultRecoveryState => {
  if (isVaultRecoveryBlockedCode(input.blockedCode)) {
    return "blocked";
  }
  if (input.opening) {
    return "opening";
  }
  const { snapshot, attachments } = input;
  if (!snapshot) {
    return "recovering-local";
  }
  if (snapshot.unsyncedReason === "conflict") {
    return "conflict";
  }
  if (snapshot.status === "unsynced" && snapshot.unsyncedReason === "error") {
    return "error";
  }
  // A failed attachment is a fail-closed outcome (integrity/authorization), not
  // a transient retry. Surface it once nothing else is pending.
  if (attachments.failed > 0 && attachments.pending === 0) {
    return "error";
  }
  // Without IndexedDB we must never claim the local copy is safe.
  if (
    !input.localStorageAvailable &&
    (snapshot.status === "unsynced" ||
      snapshot.localPersistence === "not-persisted")
  ) {
    return "error";
  }
  if (snapshot.status === "synced" && attachments.pending === 0) {
    return "synced";
  }
  if (
    snapshot.status === "syncing" ||
    (attachments.pending > 0 && input.isOnline)
  ) {
    return "syncing";
  }
  if (!input.isOnline) {
    if (
      snapshot.localPersistence === "local-persisted" &&
      input.localStorageAvailable
    ) {
      return "offline-local-safe";
    }
    return "local-restored";
  }
  if (snapshot.status === "unsynced") {
    return "syncing";
  }
  return "local-restored";
};

export interface VaultRecoveryReporter {
  update(patch: Partial<VaultRecoveryInput>): VaultRecoveryState;
  getState(): VaultRecoveryState;
  getInput(): VaultRecoveryInput;
  subscribe(listener: (state: VaultRecoveryState) => void): () => void;
  dispose(): void;
}

export const createVaultRecoveryReporter = (
  initial: VaultRecoveryInput,
): VaultRecoveryReporter => {
  let input: VaultRecoveryInput = { ...initial };
  let state = deriveVaultRecoveryState(input);
  const listeners = new Set<(state: VaultRecoveryState) => void>();
  let disposed = false;

  const recompute = () => {
    const next = deriveVaultRecoveryState(input);
    if (next !== state) {
      state = next;
      for (const listener of listeners) {
        listener(state);
      }
    }
    return state;
  };

  return {
    update(patch) {
      input = { ...input, ...patch };
      return recompute();
    },
    getState: () => state,
    getInput: () => input,
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
};
