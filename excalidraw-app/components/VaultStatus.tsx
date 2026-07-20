import React from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import "./VaultStatus.scss";

import type {
  VaultAutosaveUnsyncedReason,
  VaultErrorCode,
  VaultRole,
  VaultSyncStatus,
} from "../data/vault";

const getSyncLabel = (status: VaultSyncStatus) => {
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

export const VaultStatus = ({
  role,
  syncStatus,
  autosaveErrorCode,
  autosaveUnsyncedReason,
}: {
  role: VaultRole;
  syncStatus: VaultSyncStatus;
  autosaveErrorCode?: VaultErrorCode | null;
  autosaveUnsyncedReason?: VaultAutosaveUnsyncedReason | null;
}) => (
  <div
    className={`VaultStatus VaultStatus--${syncStatus}`}
    data-testid="vault-status"
    data-autosave-error-code={autosaveErrorCode ?? undefined}
    data-autosave-unsynced-reason={autosaveUnsyncedReason ?? undefined}
    role="status"
  >
    <span className="VaultStatus__lock" aria-hidden="true">
      ◈
    </span>
    <span>{t("vault.status.encrypted")}</span>
    <span className="VaultStatus__separator">·</span>
    <span>
      {role === "editor" ? t("vault.status.editor") : t("vault.status.viewer")}
    </span>
    <span className="VaultStatus__separator">·</span>
    <span>{getSyncLabel(syncStatus)}</span>
  </div>
);
