import React from "react";

import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";

import "./VaultConflictDialog.scss";

/**
 * Metadata about a preserved CAS fork. Both branches stay intact: this dialog
 * never overwrites the remote snapshot, never deletes the local outbox and
 * never marks either branch as synced.
 */
export interface VaultConflictInfo {
  localUpdateId: string;
  localGeneration: number;
  remoteGeneration: number | null;
  conflictReason: string | null;
}

type ExportState = "idle" | "exporting" | "done" | "error";

export const VaultConflictDialog = ({
  open,
  conflict,
  onClose,
  onExportLocal,
}: {
  open: boolean;
  conflict: VaultConflictInfo | null;
  onClose: () => void;
  onExportLocal: () => Promise<void>;
}) => {
  const [showRemote, setShowRemote] = React.useState(false);
  const [exportState, setExportState] = React.useState<ExportState>("idle");

  React.useEffect(() => {
    if (!open) {
      setShowRemote(false);
      setExportState("idle");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const exportLocal = async () => {
    setExportState("exporting");
    try {
      await onExportLocal();
      setExportState("done");
    } catch {
      setExportState("error");
    }
  };

  return (
    <Dialog
      title={t("vault.conflict.title")}
      onCloseRequest={onClose}
      size="small"
      closeOnClickOutside={false}
    >
      <div className="VaultConflictDialog" data-testid="vault-conflict-dialog">
        <p>{t("vault.conflict.description")}</p>
        <p className="VaultConflictDialog__note">
          {t("vault.conflict.deviceNote")}
        </p>

        {conflict && (
          <dl className="VaultConflictDialog__meta">
            <div>
              <dt>{t("vault.conflict.localGeneration")}</dt>
              <dd data-testid="vault-conflict-local-generation">
                {conflict.localGeneration}
              </dd>
            </div>
            <div>
              <dt>{t("vault.conflict.remoteGeneration")}</dt>
              <dd data-testid="vault-conflict-remote-generation">
                {conflict.remoteGeneration ??
                  t("vault.conflict.remoteUnavailable")}
              </dd>
            </div>
          </dl>
        )}

        {showRemote && (
          <p
            className="VaultConflictDialog__remote"
            data-testid="vault-conflict-remote"
          >
            {conflict?.remoteGeneration != null
              ? t("vault.conflict.remoteDetail", {
                  generation: conflict.remoteGeneration,
                })
              : t("vault.conflict.remoteUnavailable")}
          </p>
        )}

        {exportState === "done" && (
          <p role="status" data-testid="vault-conflict-export-done">
            {t("vault.conflict.exported")}
          </p>
        )}
        {exportState === "error" && (
          <p role="alert" data-testid="vault-conflict-export-error">
            {t("vault.conflict.exportFailed")}
          </p>
        )}

        <div className="VaultConflictDialog__actions">
          <Button onSelect={onClose}>{t("vault.conflict.keepLocal")}</Button>
          <Button onSelect={() => setShowRemote((value) => !value)}>
            {showRemote
              ? t("vault.conflict.hideRemote")
              : t("vault.conflict.viewRemote")}
          </Button>
          <Button onSelect={exportLocal} disabled={exportState === "exporting"}>
            {t("vault.conflict.exportLocal")}
          </Button>
          <Button onSelect={onClose}>{t("vault.conflict.later")}</Button>
        </div>
      </div>
    </Dialog>
  );
};
