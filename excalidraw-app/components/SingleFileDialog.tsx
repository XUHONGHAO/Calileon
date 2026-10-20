import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  createSingleFileBlob,
  fetchSingleFileRuntimeTemplate,
  normalizeSingleFileName,
  SINGLE_FILE_WARNING_BYTES,
} from "../single-file/exportSingleFile";
import { createSingleFilePayload } from "../single-file/payload";
import { saveSingleFileAs } from "../single-file/saveSingleFile";

import "./SingleFileDialog.scss";
import {
  Callout,
  DialogActions,
  DialogSection,
  UiButton,
  confirmAction,
} from "./ui";

const formatBytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export const SingleFileDialog = ({
  open,
  onClose,
  excalidrawAPI,
  langCode,
}: {
  open: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  langCode?: string;
}) => {
  const [isExporting, setIsExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [runtimeTemplate, setRuntimeTemplate] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setRuntimeTemplate(null);
    fetchSingleFileRuntimeTemplate()
      .then((template) => {
        if (!cancelled) {
          setRuntimeTemplate(template);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t("singleFile.errors.exportFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const onExport = async () => {
    if (!excalidrawAPI || !runtimeTemplate || isExporting) {
      return;
    }

    setIsExporting(true);
    setError(null);
    try {
      const name = excalidrawAPI.getName();
      const payload = createSingleFilePayload({
        elements: excalidrawAPI.getSceneElements(),
        appState: excalidrawAPI.getAppState(),
        files: excalidrawAPI.getFiles(),
        name,
        generatorVersion: import.meta.env.VITE_APP_GIT_SHA || "development",
        language: langCode || document.documentElement.lang || undefined,
      });
      const blob = createSingleFileBlob(runtimeTemplate, payload);

      if (
        blob.size > SINGLE_FILE_WARNING_BYTES &&
        !(await confirmAction(
          t("singleFile.sizeWarning", { size: formatBytes(blob.size) }),
          { danger: false },
        ))
      ) {
        return;
      }

      await saveSingleFileAs({
        blob,
        filename: normalizeSingleFileName(name),
      });
      excalidrawAPI.setToast({ message: t("singleFile.success.exported") });
      onClose();
    } catch (exportError) {
      if (
        exportError instanceof DOMException &&
        exportError.name === "AbortError"
      ) {
        return;
      }
      console.error("Single-file export failed", exportError);
      setError(t("singleFile.errors.exportFailed"));
    } finally {
      setIsExporting(false);
    }
  };

  const overwriteSupported =
    typeof window !== "undefined" && "showOpenFilePicker" in window;

  return (
    <Dialog title={t("singleFile.title")} onCloseRequest={onClose} size="small">
      <div className="SingleFileDialog">
        <p>{t("singleFile.description")}</p>
        <p>{t("singleFile.support")}</p>

        <DialogSection title={t("singleFile.browserSupportTitle")}>
          <p>{t("singleFile.browserSupport")}</p>
          <p>
            {overwriteSupported
              ? t("singleFile.overwriteSupported")
              : t("singleFile.overwriteUnsupported")}
          </p>
        </DialogSection>

        <DialogSection title={t("singleFile.fileBoundaryTitle")}>
          <p>{t("singleFile.fileBoundary")}</p>
        </DialogSection>

        {error && <Callout tone="danger">{error}</Callout>}

        <DialogActions>
          <UiButton onClick={onClose}>{t("buttons.cancel")}</UiButton>
          <UiButton
            variant="primary"
            onClick={onExport}
            loading={isExporting}
            disabled={!excalidrawAPI || !runtimeTemplate}
          >
            {isExporting ? t("singleFile.exporting") : t("singleFile.export")}
          </UiButton>
        </DialogActions>
      </div>
    </Dialog>
  );
};
