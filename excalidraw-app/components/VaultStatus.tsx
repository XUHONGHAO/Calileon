import clsx from "clsx";
import React from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import { UiButton } from "./ui";

import "./VaultStatus.scss";

import type { UiTone } from "./ui";

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
    case "realtime-lost":
      return t("vault.status.realtimeLost");
    case "blocked":
      return t("vault.status.blocked");
    case "error":
      return t("vault.status.unsynced");
  }
};

// The colour must match the label. When a recovery state is shown it wins over
// the raw snapshot status, which ignores pending attachments and reload state;
// terminal session states keep their own styling.
const getStatusTone = (
  syncStatus: VaultSyncStatus,
  recoveryState?: VaultRecoveryState,
): VaultSyncStatus | "local" => {
  if (
    !recoveryState ||
    syncStatus === "revoked" ||
    syncStatus === "expired" ||
    syncStatus === "closed"
  ) {
    return syncStatus;
  }
  switch (recoveryState) {
    case "opening":
    case "recovering-local":
      return "loading";
    case "syncing":
      return "syncing";
    case "synced":
      return "synced";
    // Kept on this device: not synced yet, but not a failure either.
    case "local-restored":
    case "offline-local-safe":
      return "local";
    case "conflict":
    case "realtime-lost":
    case "blocked":
    case "error":
      return "unsynced";
  }
};

const getUiTone = (
  syncStatus: VaultSyncStatus,
  unsyncedReason?: VaultAutosaveUnsyncedReason | null,
  recoveryState?: VaultRecoveryState,
): UiTone => {
  if (syncStatus === "revoked" || syncStatus === "expired") {
    return "danger";
  }
  if (syncStatus === "closed") {
    return "neutral";
  }
  if (recoveryState) {
    switch (recoveryState) {
      case "opening":
      case "recovering-local":
        return "neutral";
      case "syncing":
        return "info";
      case "synced":
        return "success";
      // safe on this device or waiting for the user: not a failure
      case "local-restored":
      case "offline-local-safe":
      case "conflict":
      case "realtime-lost":
        return "warning";
      case "blocked":
      case "error":
        return "danger";
    }
  }
  switch (syncStatus) {
    case "loading":
      return "neutral";
    case "syncing":
      return "info";
    case "synced":
      return "success";
    case "unsynced":
      return unsyncedReason === "conflict" ? "warning" : "danger";
  }
};

/**
 * Shared Vault status pill (v1 and v2). "Encrypted · role" and the details
 * collapse at narrow widths; the full text stays in the tooltip and is still
 * read by screen readers.
 */
export const VaultStatusPill = ({
  tone,
  legacyTone,
  role,
  label,
  details,
  action,
  ...dataProps
}: {
  tone: UiTone;
  /** kept for e2e selectors and tests (VaultStatus--synced, ...) */
  legacyTone: string;
  role: VaultRole;
  label: string;
  details?: { text: string; testId: string }[];
  action?: React.ReactNode;
} & { [key: `data-${string}`]: string | number | undefined }) => {
  const meta = [
    t("vault.status.encrypted"),
    role === "editor" ? t("vault.status.editor") : t("vault.status.viewer"),
  ];
  const fullText = [label, ...(details ?? []).map((detail) => detail.text)];
  return (
    <div
      {...dataProps}
      className={clsx(
        "VaultStatus",
        `VaultStatus--${legacyTone}`,
        "UiStatusPill",
        `UiStatusPill--${tone}`,
      )}
      role="status"
      title={[...meta, ...fullText].join(" · ")}
    >
      <span className="UiStatusPill__mark" aria-hidden="true">
        <span className="UiStatusPill__dot" />
      </span>
      <span className="UiStatusPill__text VaultStatus__text">
        <span className="VaultStatus__meta">
          {meta.map((item) => (
            <React.Fragment key={item}>
              <span>{item}</span>
              <span className="VaultStatus__separator" aria-hidden="true">
                ·
              </span>
            </React.Fragment>
          ))}
        </span>
        <span className="UiStatusPill__label VaultStatus__label">{label}</span>
        {details?.map((detail) => (
          <span className="VaultStatus__detail" key={detail.testId}>
            <span className="VaultStatus__separator" aria-hidden="true">
              ·
            </span>
            <span data-testid={detail.testId}>{detail.text}</span>
          </span>
        ))}
      </span>
      {action}
    </div>
  );
};

export const VaultStatus = ({
  role,
  syncStatus,
  autosaveErrorCode,
  autosaveUnsyncedReason,
  autosaveLocalPersistence,
  autosaveBeforeUnloadState,
  recoveryState,
  realtimeLostReason,
  realtimeLostCode,
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
  /** Non-secret diagnostics: loss reason trail and first error code. */
  realtimeLostReason?: string;
  realtimeLostCode?: VaultErrorCode | null;
  attachmentPending?: number;
  attachmentFailed?: number;
  onReviewConflict?: () => void;
}) => {
  const pendingAttachments = attachmentPending ?? 0;
  const failedAttachments = attachmentFailed ?? 0;
  const baseTone = getUiTone(syncStatus, autosaveUnsyncedReason, recoveryState);
  const details: { text: string; testId: string }[] = [];
  if (pendingAttachments > 0) {
    details.push({
      text: t("vault.status.attachmentsPending", {
        pending: pendingAttachments,
      }),
      testId: "vault-attachments-pending",
    });
  }
  if (failedAttachments > 0) {
    details.push({
      text: t("vault.status.attachmentsFailed", { failed: failedAttachments }),
      testId: "vault-attachments-failed",
    });
  }
  return (
    <VaultStatusPill
      // Failed uploads need attention even when the scene itself synced.
      tone={
        failedAttachments > 0 &&
        (baseTone === "success" ||
          baseTone === "info" ||
          baseTone === "neutral")
          ? "warning"
          : baseTone
      }
      legacyTone={getStatusTone(syncStatus, recoveryState)}
      role={role}
      label={
        recoveryState
          ? getRecoveryLabel(recoveryState)
          : getSyncLabel(syncStatus, autosaveUnsyncedReason)
      }
      details={details.length > 0 ? details : undefined}
      action={
        recoveryState === "conflict" &&
        onReviewConflict && (
          <UiButton
            size="sm"
            className="VaultStatus__review"
            data-testid="vault-review-conflict"
            onClick={onReviewConflict}
          >
            {t("vault.conflict.review")}
          </UiButton>
        )
      }
      data-testid="vault-status"
      data-sync-status={syncStatus}
      data-autosave-error-code={autosaveErrorCode ?? undefined}
      data-autosave-unsynced-reason={autosaveUnsyncedReason ?? undefined}
      data-autosave-local-persistence={autosaveLocalPersistence ?? undefined}
      data-autosave-before-unload-state={autosaveBeforeUnloadState ?? undefined}
      data-recovery-state={recoveryState ?? undefined}
      data-realtime-lost-reason={realtimeLostReason ?? undefined}
      data-realtime-lost-code={realtimeLostCode ?? undefined}
      data-attachment-pending={attachmentPending ?? undefined}
      data-attachment-failed={attachmentFailed ?? undefined}
    />
  );
};
