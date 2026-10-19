/**
 * Vault v2 (P4c) W6: the session state the App renders (status pill,
 * attachment summary, conflict list) as a tiny external store for
 * `useSyncExternalStore`, plus the one-off notice channel (toasts).
 */
import type { VaultErrorCode } from "../errors";
import type { VaultLocalAttachmentTaskRecord } from "../local-store/domain";
import type { VaultV2Notice } from "./notices";
import type { VaultV2Status } from "./syncEngine";

/**
 * "retry": every failed upload is transient (network, 5xx, rate limit/quota)
 * and is resumed automatically; "action": at least one needs the user
 * (permission, integrity, size).
 */
export type VaultV2AttachmentFailure = "retry" | "action" | null;

export type VaultV2UiState = {
  readonly status: VaultV2Status;
  readonly blockedCode: VaultErrorCode | null;
  /** edits survive offline/reload (local store open) */
  readonly localSafe: boolean;
  readonly attachmentPending: number;
  readonly attachmentFailed: number;
  readonly attachmentFailure: VaultV2AttachmentFailure;
  readonly conflictElementIds: readonly string[];
};

const RETRYABLE: readonly (VaultErrorCode | null)[] = [
  "VAULT_PERSISTENCE_UNAVAILABLE",
  "VAULT_RATE_LIMITED",
];

export const classifyAttachmentFailures = (
  tasks: readonly Pick<
    VaultLocalAttachmentTaskRecord,
    "status" | "errorCode"
  >[],
): VaultV2AttachmentFailure => {
  let failure: VaultV2AttachmentFailure = null;
  for (const task of tasks) {
    if (task.status !== "failed") {
      continue;
    }
    if (!RETRYABLE.includes(task.errorCode)) {
      return "action";
    }
    failure = "retry";
  }
  return failure;
};

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export class VaultV2UiStore {
  private state: VaultV2UiState = {
    status: "connecting",
    blockedCode: null,
    localSafe: false,
    attachmentPending: 0,
    attachmentFailed: 0,
    attachmentFailure: null,
    conflictElementIds: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: VaultV2Notice) => void>();

  get = (): VaultV2UiState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onNotice = (listener: (notice: VaultV2Notice) => void) => {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  };

  update(patch: Partial<VaultV2UiState>) {
    const next = { ...this.state, ...patch };
    if (
      patch.conflictElementIds &&
      sameIds(patch.conflictElementIds, this.state.conflictElementIds)
    ) {
      next.conflictElementIds = this.state.conflictElementIds;
    }
    // a blocked session stays blocked (status events may still trickle in).
    // The engine reports "blocked" before the transport's onBlocked carries
    // the reason, so the first code still lands; later ones never replace it.
    if (this.state.status === "blocked") {
      next.status = "blocked";
      next.blockedCode = this.state.blockedCode ?? patch.blockedCode ?? null;
    }
    const changed = (Object.keys(next) as (keyof VaultV2UiState)[]).some(
      (key) => next[key] !== this.state[key],
    );
    if (!changed) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  emit(notice: VaultV2Notice) {
    for (const listener of this.noticeListeners) {
      listener(notice);
    }
  }
}
