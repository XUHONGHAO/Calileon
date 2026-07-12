import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
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

const formatBytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export const SingleFileDialog = ({
  open,
  onClose,
  excalidrawAPI,
}: {
  open: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
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
      });
      const blob = createSingleFileBlob(runtimeTemplate, payload);

      if (
        blob.size > SINGLE_FILE_WARNING_BYTES &&
        !window.confirm(
          t("singleFile.sizeWarning", { size: formatBytes(blob.size) }),
        )
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

        <section>
          <h3>{t("singleFile.browserSupportTitle")}</h3>
          <p>{t("singleFile.browserSupport")}</p>
          <p>
            {overwriteSupported
              ? t("singleFile.overwriteSupported")
              : t("singleFile.overwriteUnsupported")}
          </p>
        </section>

        <section>
          <h3>{t("singleFile.fileBoundaryTitle")}</h3>
          <p>{t("singleFile.fileBoundary")}</p>
        </section>

        {error && <div className="SingleFileDialog__error">{error}</div>}

        <div className="SingleFileDialog__actions">
          <FilledButton
            label={
              isExporting ? t("singleFile.exporting") : t("singleFile.export")
            }
            onClick={onExport}
            disabled={!excalidrawAPI || !runtimeTemplate || isExporting}
          />
        </div>
      </div>
    </Dialog>
  );
};
