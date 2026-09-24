import React from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import "./VaultStatus.scss";

import type {
  VaultAutosaveUnsyncedReason,
  VaultErrorCode,
  VaultRecoveryState,
  VaultRole,
  VaultSyncStatus,
} from "../data/vault";

const getSyncLabel = (
  status: VaultSyncStatus,
  unsyncedReason?: VaultAutosaveUnsyncedReason | null,
) => {
  if (status === "unsynced" && unsyncedReason === "conflict") {
    return t("vault.status.conflict");
  }
  switch (status) {
    case "loading":
      return t("vault.status.loading");
    case "syncing":
      return t("vault.status.syncing");
    case "synced":
      return t("vault.status.synced");
    case "unsynced":
      return t("vault.status.unsynced");
    case "revoked":
      return t("vault.status.revoked");
    case "expired":
      return t("vault.status.expired");
    case "closed":
      return t("vault.status.closed");
  }
};

const getRecoveryLabel = (state: VaultRecoveryState): string => {
  switch (state) {
    case "opening":
    case "recovering-local":
      return t("vault.status.loading");
    case "local-restored":
      return t("vault.status.localSaved");
    case "syncing":
      return t("vault.status.syncing");
    case "synced":
      return t("vault.status.synced");
    case "offline-local-safe":
      return t("vault.status.offlineSafe");
    case "conflict":
      return t("vault.status.conflict");
    case "blocked":
      return t("vault.status.blocked");
    case "error":
      return t("vault.status.unsynced");
  }
};

export const VaultStatus = ({
  role,
  syncStatus,
  autosaveErrorCode,
  autosaveUnsyncedReason,
  autosaveLocalPersistence,
  autosaveBeforeUnloadState,
  recoveryState,
  attachmentPending,
  attachmentFailed,
  onReviewConflict,
}: {
  role: VaultRole;
  syncStatus: VaultSyncStatus;
  autosaveErrorCode?: VaultErrorCode | null;
  autosaveUnsyncedReason?: VaultAutosaveUnsyncedReason | null;
  autosaveLocalPersistence?:
    | "not-persisted"
    | "local-persisted"
    | "remote-confirmed";
  autosaveBeforeUnloadState?:
    | "none"
    | "local-persistence-pending"
    | "local-persisted-unsynced";
  recoveryState?: VaultRecoveryState;
  attachmentPending?: number;
  attachmentFailed?: number;
  onReviewConflict?: () => void;
}) => {
  const pendingAttachments = attachmentPending ?? 0;
  return (
    <div
      className={`VaultStatus VaultStatus--${syncStatus}`}
      data-testid="vault-status"
      data-autosave-error-code={autosaveErrorCode ?? undefined}
      data-autosave-unsynced-reason={autosaveUnsyncedReason ?? undefined}
      data-autosave-local-persistence={autosaveLocalPersistence ?? undefined}
      data-autosave-before-unload-state={autosaveBeforeUnloadState ?? undefined}
      data-recovery-state={recoveryState ?? undefined}
      data-attachment-pending={attachmentPending ?? undefined}
      data-attachment-failed={attachmentFailed ?? undefined}
      role="status"
    >
      <span className="VaultStatus__lock" aria-hidden="true">
        ◈
      </span>
      <span>{t("vault.status.encrypted")}</span>
      <span className="VaultStatus__separator">·</span>
      <span>
        {role === "editor"
          ? t("vault.status.editor")
          : t("vault.status.viewer")}
      </span>
      <span className="VaultStatus__separator">·</span>
      <span>
        {recoveryState
          ? getRecoveryLabel(recoveryState)
          : getSyncLabel(syncStatus, autosaveUnsyncedReason)}
      </span>
      {pendingAttachments > 0 && (
        <>
          <span className="VaultStatus__separator">·</span>
          <span data-testid="vault-attachments-pending">
            {t("vault.status.attachmentsPending", {
              pending: pendingAttachments,
            })}
          </span>
        </>
      )}
      {recoveryState === "conflict" && onReviewConflict && (
        <button
          type="button"
          className="VaultStatus__review"
          data-testid="vault-review-conflict"
          onClick={onReviewConflict}
        >
          {t("vault.conflict.review")}
        </button>
      )}
    </div>
  );
};
