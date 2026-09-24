import { VaultError, type VaultErrorCode } from "./errors";
import {
  createVaultOutboxController,
  type VaultOutboxSendResult,
} from "./outbox";
import {
  encryptVaultSnapshot,
  loadVaultSnapshot,
  saveVaultSnapshot,
} from "./snapshot";

import type { VaultLocalOutboxRecord } from "./local-store/domain";
import type { VaultLocalStore } from "./local-store/store";

import type { VaultPersistenceService } from "./persistence";
import type { VaultRole } from "./types";

export type VaultAutosaveUnsyncedReason =
  | "pending"
  | "offline"
  | "conflict"
  | "error";

export type VaultAutosaveLocalPersistenceState =
  | "not-persisted"
  | "local-persisted"
  | "remote-confirmed";

export type VaultAutosaveBeforeUnloadState =
  | "none"
  | "local-persistence-pending"
  | "local-persisted-unsynced";

export interface VaultSnapshotAutosaveState {
  readonly status: "synced" | "syncing" | "unsynced";
  readonly generation: number;
  readonly hasPendingChanges: boolean;
  readonly unsyncedReason: VaultAutosaveUnsyncedReason | null;
  readonly errorCode: VaultErrorCode | null;
  readonly localPersistence: VaultAutosaveLocalPersistenceState;
}

export interface VaultSnapshotAutosaveController<TSnapshot> {
  schedule(snapshot: TSnapshot): void;
  flush(): Promise<VaultSnapshotAutosaveState>;
  retry(): Promise<VaultSnapshotAutosaveState>;
  getState(): VaultSnapshotAutosaveState;
  shouldWarnBeforeUnload(): boolean;
  getBeforeUnloadState(): VaultAutosaveBeforeUnloadState;
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
  roomId?: string;
  localStore?: VaultLocalStore | Promise<VaultLocalStore>;
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
 * Keeps only the latest unsaved snapshot in memory. When a local store is
 * provided, every revision is first committed as an encrypted snapshot and
 * durable outbox record before any remote CAS attempt.
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

  if (input.localStore && !input.roomId) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault local outbox requires a room ID.",
    );
  }

  const localStorePromise = input.localStore
    ? Promise.resolve(input.localStore)
    : null;
  const outboxPromise = localStorePromise
    ? localStorePromise.then((store) =>
        createVaultOutboxController({
          store,
          persistence: input.persistence,
          vaultId: input.vaultId,
          roomId: input.roomId as string,
          invitationCapability: input.invitationCapability,
          isOnline: input.isOnline,
        }),
      )
    : null;

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
  let queuedOutbox:
    | Readonly<{
        revision: number;
        record: VaultLocalOutboxRecord;
      }>
    | undefined;
  let disposed = false;
  let localPersistence: VaultAutosaveLocalPersistenceState = "remote-confirmed";
  let state: VaultSnapshotAutosaveState = Object.freeze({
    status: "synced",
    generation,
    hasPendingChanges: false,
    unsyncedReason: null,
    errorCode: null,
    localPersistence,
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
      localPersistence,
    });
    input.onStateChange?.(state);
  };

  const applyOutboxResults = (results: readonly VaultOutboxSendResult[]) => {
    for (const result of results) {
      if (result.status === "offline") {
        localPersistence = "local-persisted";
        publish("unsynced", "offline", "VAULT_PERSISTENCE_UNAVAILABLE");
      } else if (result.status === "confirmed") {
        generation = result.result.generation;
        localPersistence = "remote-confirmed";
        // A drain can confirm the record that a pending in-memory revision was
        // already queued as. Clear that revision so a later save does not reuse
        // the deleted outbox record and misreport the Vault as offline.
        if (queuedOutbox?.record.updateId === result.record.updateId) {
          if (pending?.revision === queuedOutbox.revision) {
            pending = undefined;
          }
          queuedOutbox = undefined;
        }
        if (pending === undefined && inFlight === undefined) {
          publish("synced");
        }
      } else if (result.status === "conflict") {
        localPersistence = "local-persisted";
        publish("unsynced", "conflict", "VAULT_SNAPSHOT_CONFLICT");
      } else if (result.status === "failed") {
        localPersistence = "local-persisted";
        publish("unsynced", "error", result.errorCode);
      }
    }
  };

  const drainOutbox = async () => {
    if (!outboxPromise) {
      return;
    }
    const outbox = await outboxPromise;
    applyOutboxResults(await outbox.drain());
  };

  const recoveryPromise = drainOutbox().catch((error) => {
    publish(
      "unsynced",
      "error",
      error instanceof VaultError
        ? error.code
        : "VAULT_LOCAL_STORAGE_UNAVAILABLE",
    );
  });

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
    let saving = pending;
    inFlightRevision = saving.revision;
    publish("syncing");
    inFlight = (async () => {
      try {
        if (localStorePromise && outboxPromise) {
          const [store, outbox] = await Promise.all([
            localStorePromise,
            outboxPromise,
          ]);
          let queued =
            queuedOutbox?.revision === saving.revision
              ? queuedOutbox.record
              : undefined;
          if (!queued) {
            const existing = await store.listOutbox({
              vaultId: input.vaultId,
              roomId: input.roomId as string,
            });
            const expectedGeneration = existing.reduce(
              (maximum, record) =>
                Math.max(
                  maximum,
                  record.envelope.purpose === "snapshot"
                    ? record.envelope.generation
                    : maximum,
                ),
              generation,
            );
            const envelope = await encryptVaultSnapshot({
              vaultId: input.vaultId,
              rootKey: input.rootKey,
              generation: expectedGeneration + 1,
              snapshot: saving.snapshot,
            });
            queued = await store.createSnapshotOutboxRecord({
              vaultId: input.vaultId,
              roomId: input.roomId as string,
              envelope,
              expectedGeneration,
            });
            await store.putSnapshotAndOutbox({
              vaultId: input.vaultId,
              roomId: input.roomId as string,
              rootKey: input.rootKey,
              generation: expectedGeneration + 1,
              snapshot: saving.snapshot,
              outbox: queued,
            });
            localPersistence = "local-persisted";
            queuedOutbox = Object.freeze({
              revision: saving.revision,
              record: queued,
            });
          }
          if (!input.isOnline()) {
            localPersistence = "local-persisted";
            publish("unsynced", "offline", "VAULT_PERSISTENCE_UNAVAILABLE");
            return;
          }
          const sent = await outbox.send(queued.updateId);
          if (!sent || sent.status === "offline") {
            localPersistence = "local-persisted";
            publish("unsynced", "offline", "VAULT_PERSISTENCE_UNAVAILABLE");
            return;
          }
          if (sent.status === "conflict") {
            localPersistence = "local-persisted";
            publish("unsynced", "conflict", "VAULT_SNAPSHOT_CONFLICT");
            return;
          }
          if (sent.status === "failed") {
            localPersistence = "local-persisted";
            publish("unsynced", "error", sent.errorCode);
            return;
          }
          generation = sent.result.generation;
          localPersistence = "remote-confirmed";
          if (pending?.revision === saving.revision) {
            pending = undefined;
            queuedOutbox = undefined;
          }
          publish(pending ? "unsynced" : "synced", pending ? "pending" : null);
          return;
        }
        if (!input.isOnline()) {
          publish("unsynced", "offline", "VAULT_PERSISTENCE_UNAVAILABLE");
          return;
        }
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
            localPersistence = "remote-confirmed";
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
            localPersistence = "not-persisted";
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
            localPersistence = "not-persisted";
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
    await recoveryPromise;
    await drainOutbox();
    readyToSave =
      pending !== undefined && pending.revision !== inFlightRevision;
    const currentInFlight = inFlight;
    if (currentInFlight) {
      await currentInFlight;
      if (inFlight === currentInFlight) {
        inFlight = undefined;
      }
    }
    await saveReadySnapshot();
    const nextInFlight = inFlight;
    if (nextInFlight) {
      await nextInFlight;
      if (inFlight === nextInFlight) {
        inFlight = undefined;
      }
    }
    return state;
  };

  return Object.freeze({
    schedule(snapshot: TSnapshot) {
      if (disposed) {
        throw new VaultError("VAULT_INTERNAL", "Vault autosave is closed.");
      }
      pending = Object.freeze({ revision: ++revision, snapshot });
      localPersistence = "not-persisted";
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
      (
        Object.freeze({
          none: false,
          "local-persistence-pending": true,
          "local-persisted-unsynced": true,
        }) as Record<VaultAutosaveBeforeUnloadState, boolean>
      )[
        (() => {
          if (
            pending === undefined &&
            inFlight === undefined &&
            state.status === "synced"
          ) {
            return "none";
          }
          return localPersistence === "local-persisted"
            ? "local-persisted-unsynced"
            : "local-persistence-pending";
        })()
      ],
    getBeforeUnloadState: () => {
      if (
        pending === undefined &&
        inFlight === undefined &&
        state.status === "synced"
      ) {
        return "none";
      }
      return localPersistence === "local-persisted"
        ? "local-persisted-unsynced"
        : "local-persistence-pending";
    },
    dispose() {
      disposed = true;
      clearTimer();
      void outboxPromise?.then((outbox) => outbox.dispose());
    },
  });
};
