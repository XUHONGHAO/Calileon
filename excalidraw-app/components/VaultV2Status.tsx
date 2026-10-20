import React from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import { UiButton } from "./ui";
import { VaultStatusPill } from "./VaultStatus";

import type { UiTone } from "./ui";
import type { VaultRole } from "../data/vault";
import type { VaultV2UiState } from "../data/vault/v2/uiState";

const getStatusLabel = (state: VaultV2UiState) => {
  switch (state.status) {
    case "connecting":
      return t("vault.status.loading");
    case "syncing":
      return t("vault.status.syncing");
    case "synced":
      return t("vault.status.synced");
    case "offline":
      return state.localSafe
        ? t("vault.status.offlineSafe")
        : t("vault.status.unsynced");
    case "blocked":
      switch (state.blockedCode) {
        case "VAULT_CAPABILITY_REVOKED":
          return t("vault.status.revoked");
        case "VAULT_CAPABILITY_EXPIRED":
          return t("vault.status.expired");
        default:
          return t("vault.status.blocked");
      }
  }
};

// same tones as the v1 pill (VaultStatus.scss)
const getStatusTone = (state: VaultV2UiState) => {
  switch (state.status) {
    case "connecting":
      return "loading";
    case "syncing":
    case "synced":
      return state.status;
    case "offline":
      return state.localSafe ? "local" : "unsynced";
    case "blocked":
      return state.blockedCode === "VAULT_CAPABILITY_REVOKED"
        ? "revoked"
        : state.blockedCode === "VAULT_CAPABILITY_EXPIRED"
        ? "expired"
        : "unsynced";
  }
};

const getUiTone = (state: VaultV2UiState): UiTone => {
  switch (state.status) {
    case "connecting":
      return "neutral";
    case "syncing":
      return "info";
    case "synced":
      return state.attachmentFailed > 0 || state.conflictElementIds.length > 0
        ? "warning"
        : "success";
    case "offline":
      return state.localSafe ? "warning" : "danger";
    case "blocked":
      return "danger";
  }
};

/** W6: the v2 status pill (sync state, attachments, concurrent edits) */
export const VaultV2Status = ({
  role,
  state,
  onShowConflicts,
}: {
  role: VaultRole;
  state: VaultV2UiState;
  onShowConflicts?: (elementIds: readonly string[]) => void;
}) => {
  const conflicts = state.conflictElementIds.length;
  const details: { text: string; testId: string }[] = [];
  if (state.attachmentPending > 0) {
    details.push({
      text: t("vault.status.attachmentsPending", {
        pending: state.attachmentPending,
      }),
      testId: "vault-attachments-pending",
    });
  }
  if (state.attachmentFailed > 0) {
    details.push({
      text:
        state.attachmentFailure === "retry"
          ? t("vault.v2.attachmentsRetry", { failed: state.attachmentFailed })
          : t("vault.v2.attachmentsAction", { failed: state.attachmentFailed }),
      testId: "vault-attachments-failed",
    });
  }
  if (conflicts > 0) {
    details.push({
      text: t("vault.v2.conflicts", { count: conflicts }),
      testId: "vault-v2-conflicts",
    });
  }
  return (
    <VaultStatusPill
      tone={getUiTone(state)}
      legacyTone={getStatusTone(state)}
      role={role}
      label={getStatusLabel(state)}
      details={details}
      action={
        conflicts > 0 &&
        onShowConflicts && (
          <UiButton
            size="sm"
            className="VaultStatus__review"
            data-testid="vault-v2-show-conflicts"
            title={t("vault.v2.conflictsHint")}
            onClick={() => onShowConflicts(state.conflictElementIds)}
          >
            {t("vault.v2.showConflicts")}
          </UiButton>
        )
      }
      data-testid="vault-v2-status"
      data-sync-status={state.status}
      data-blocked-code={state.blockedCode ?? undefined}
      data-attachment-pending={state.attachmentPending}
      data-attachment-failed={state.attachmentFailed}
      data-attachment-failure={state.attachmentFailure ?? undefined}
      data-conflicts={conflicts}
    />
  );
};
