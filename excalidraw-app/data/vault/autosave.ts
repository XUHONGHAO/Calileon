import { VaultError, type VaultErrorCode } from "./errors";
import { loadVaultSnapshot, saveVaultSnapshot } from "./snapshot";

import type { VaultPersistenceService } from "./persistence";
import type { VaultRole } from "./types";

export type VaultAutosaveUnsyncedReason =
  | "pending"
  | "offline"
  | "conflict"
  | "error";

export interface VaultSnapshotAutosaveState {
  readonly status: "synced" | "syncing" | "unsynced";
  readonly generation: number;
  readonly hasPendingChanges: boolean;
  readonly unsyncedReason: VaultAutosaveUnsyncedReason | null;
  readonly errorCode: VaultErrorCode | null;
}

export interface VaultSnapshotAutosaveController<TSnapshot> {
  schedule(snapshot: TSnapshot): void;
  flush(): Promise<VaultSnapshotAutosaveState>;
  retry(): Promise<VaultSnapshotAutosaveState>;
  getState(): VaultSnapshotAutosaveState;
  shouldWarnBeforeUnload(): boolean;
  dispose(): void;
}

export interface VaultSnapshotConflictInput<TSnapshot> {
  readonly pendingSnapshot: TSnapshot;
  readonly latestSnapshot: TSnapshot;
  readonly latestGeneration: number;
}

export interface VaultSnapshotAutosaveControllerInput<TSnapshot> {
  persistence: VaultPersistenceService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
  role: VaultRole;
  initialGeneration: number;
  debounceMs?: number;
  maxConflictRetries?: number;
  conflictRetryBaseDelayMs?: number;
  isOnline: () => boolean;
  reconcileConflict?: (
    input: VaultSnapshotConflictInput<TSnapshot>,
  ) => TSnapshot;
  onStateChange?: (state: VaultSnapshotAutosaveState) => void;
}

const DEFAULT_DEBOUNCE_MS = 1000;
const DEFAULT_MAX_CONFLICT_RETRIES = 4;
const DEFAULT_CONFLICT_RETRY_BASE_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 75;

/**
 * Keeps only the latest unsaved snapshot in memory. The controller deliberately
 * has no durable outbox and no plain or legacy persistence fallback.
 */
export const createVaultSnapshotAutosaveController = <TSnapshot>(
  input: VaultSnapshotAutosaveControllerInput<TSnapshot>,
): VaultSnapshotAutosaveController<TSnapshot> => {
  if (input.role !== "editor") {
    throw new VaultError(
      "VAULT_CAPABILITY_FORBIDDEN",
      "Viewer capability cannot start Vault snapshot autosave.",
    );
  }
  if (
    !Number.isSafeInteger(input.initialGeneration) ||
    input.initialGeneration < 0 ||
    input.initialGeneration === Number.MAX_SAFE_INTEGER
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault snapshot generation.",
    );
  }
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault autosave debounce.");
  }
  const maxConflictRetries =
    input.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
  if (!Number.isSafeInteger(maxConflictRetries) || maxConflictRetries < 0) {
    throw new VaultError(
      "VAULT_INTERNAL",
      "Invalid Vault autosave conflict retry limit.",
    );
  }

  const conflictRetryBaseDelayMs =
    input.conflictRetryBaseDelayMs ?? DEFAULT_CONFLICT_RETRY_BASE_DELAY_MS;
  if (
    !Number.isFinite(conflictRetryBaseDelayMs) ||
    conflictRetryBaseDelayMs < 0
  ) {
    throw new VaultError(
      "VAULT_INTERNAL",
      "Invalid Vault autosave conflict retry delay.",
    );
  }

  const waitForConflictRetry = async (retry: number) => {
    if (conflictRetryBaseDelayMs === 0) {
      return;
    }
    const exponentialDelay =
      conflictRetryBaseDelayMs * Math.min(2 ** retry, 16);
    const jitter = Math.floor(Math.random() * conflictRetryBaseDelayMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, exponentialDelay + jitter);
    });
  };

  let generation = input.initialGeneration;
  let revision = 0;
  let pending: Readonly<{ revision: number; snapshot: TSnapshot }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readyToSave = false;
  let inFlight: Promise<void> | undefined;
  let inFlightRevision: number | undefined;
  let disposed = false;
  let state: VaultSnapshotAutosaveState = Object.freeze({
    status: "synced",
    generation,
    hasPendingChanges: false,
    unsyncedReason: null,
    errorCode: null,
  });

  const publish = (
    status: VaultSnapshotAutosaveState["status"],
    reason: VaultAutosaveUnsyncedReason | null = null,
    errorCode: VaultErrorCode | null = null,
  ) => {
    state = Object.freeze({
      status,
      generation,
      hasPendingChanges: pending !== undefined || inFlight !== undefined,
      unsyncedReason: reason,
      errorCode,
    });
    input.onStateChange?.(state);
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const saveReadySnapshot = (): Promise<void> => {
    if (disposed || inFlight || !readyToSave || !pending) {
      return inFlight ?? Promise.resolve();
    }
    readyToSave = false;
    if (!input.isOnline()) {
      publish("unsynced", "offline", "VAULT_PERSISTENCE_UNAVAILABLE");
      return Promise.resolve();
    }

    let saving = pending;
    inFlightRevision = saving.revision;
    publish("syncing");
    inFlight = (async () => {
      try {
        let conflictRetries = 0;
        while (!disposed) {
          const result = await saveVaultSnapshot({
            persistence: input.persistence,
            vaultId: input.vaultId,
            invitationCapability: input.invitationCapability,
            rootKey: input.rootKey,
            role: input.role,
            expectedGeneration: generation,
            snapshot: saving.snapshot,
          });
          if (result.status === "synced") {
            generation = result.generation;
            if (pending?.revision === saving.revision) {
              pending = undefined;
            }
            publish(
              pending ? "unsynced" : "synced",
              pending ? "pending" : null,
            );
            return;
          }
          if (
            !input.reconcileConflict ||
            conflictRetries >= maxConflictRetries
          ) {
            publish("unsynced", "conflict", result.errorCode);
            return;
          }

          const latest = await loadVaultSnapshot<TSnapshot>({
            persistence: input.persistence,
            vaultId: input.vaultId,
            invitationCapability: input.invitationCapability,
            rootKey: input.rootKey,
          });
          if (!latest) {
            publish("unsynced", "conflict", result.errorCode);
            return;
          }

          generation = latest.generation;
          await waitForConflictRetry(conflictRetries);
          if (disposed) {
            return;
          }
          const current = pending ?? saving;
          saving = Object.freeze({
            revision: current.revision,
            snapshot: input.reconcileConflict({
              pendingSnapshot: current.snapshot,
              latestSnapshot: latest.snapshot,
              latestGeneration: latest.generation,
            }),
          });
          pending = saving;
          inFlightRevision = saving.revision;
          conflictRetries += 1;
        }
      } catch (error) {
        publish(
          "unsynced",
          "error",
          error instanceof VaultError
            ? error.code
            : "VAULT_PERSISTENCE_UNAVAILABLE",
        );
      } finally {
        inFlight = undefined;
        inFlightRevision = undefined;
        if (readyToSave && pending && !disposed) {
          void saveReadySnapshot();
        } else {
          publish(state.status, state.unsyncedReason, state.errorCode);
        }
      }
    })();
    return inFlight;
  };

  const forceSave = async () => {
    clearTimer();
    readyToSave =
      pending !== undefined && pending.revision !== inFlightRevision;
    while (inFlight) {
      await inFlight;
    }
    await saveReadySnapshot();
    while (inFlight) {
      await inFlight;
    }
    return state;
  };

  return Object.freeze({
    schedule(snapshot: TSnapshot) {
      if (disposed) {
        throw new VaultError("VAULT_INTERNAL", "Vault autosave is closed.");
      }
      pending = Object.freeze({ revision: ++revision, snapshot });
      readyToSave = false;
      clearTimer();
      publish("unsynced", "pending");
      timer = setTimeout(() => {
        timer = undefined;
        readyToSave = true;
        void saveReadySnapshot();
      }, debounceMs);
    },
    flush: forceSave,
    retry: forceSave,
    getState: () => state,
    shouldWarnBeforeUnload: () =>
      pending !== undefined ||
      inFlight !== undefined ||
      state.status !== "synced",
    dispose() {
      disposed = true;
      clearTimer();
    },
  });
};
