import React from "react";
import { createRoot } from "react-dom/client";

import { Excalidraw, MainMenu } from "@excalidraw/excalidraw/index";
import { ExportIcon, save } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createSingleFilePayload } from "./payload";
import { serializeRuntimeDocument } from "./html";
import { saveSingleFile, saveSingleFileAs } from "./saveSingleFile";
import { SINGLE_FILE_PAYLOAD_SCRIPT_ID, type SingleFilePayload } from "./types";
import { normalizeSingleFileName } from "./exportSingleFile";

const readInitialPayload = (): SingleFilePayload => {
  const node = document.getElementById(SINGLE_FILE_PAYLOAD_SCRIPT_ID);
  if (!node?.textContent) {
    throw new Error("Single-file payload is missing");
  }
  return JSON.parse(node.textContent) as SingleFilePayload;
};

const initialPayload = readInitialPayload();

const RuntimeApp = () => {
  const [api, setApi] = React.useState<ExcalidrawImperativeAPI | null>(null);
  const currentHandle = React.useRef<FileSystemFileHandle | null>(null);

  const createLatestBlob = React.useCallback(() => {
    if (!api) {
      throw new Error("Editor is not ready");
    }
    const payload = createSingleFilePayload({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
      name: api.getName() || initialPayload.document.name,
      generatorVersion: initialPayload.generator.version,
      createdAt: initialPayload.createdAt,
      updatedAt: Date.now(),
    });
    return new Blob([serializeRuntimeDocument(document, payload)], {
      type: "text/html;charset=utf-8",
    });
  }, [api]);

  const filename = normalizeSingleFileName(
    api?.getName() || initialPayload.document.name,
  );

  const onSave = async () => {
    try {
      const result = await saveSingleFile({
        blob: createLatestBlob(),
        filename,
        currentHandle: currentHandle.current,
        confirmFirstOverwrite: () =>
          window.confirm(t("singleFile.firstOverwritePrompt")),
      });
      currentHandle.current = result.handle;
      api?.setToast({
        message:
          result.mode === "overwrite"
            ? t("singleFile.success.saved")
            : t("singleFile.success.savedAs"),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      api?.setToast({ message: t("singleFile.errors.saveFailed") });
    }
  };

  const onSaveAs = async () => {
    try {
      await saveSingleFileAs({ blob: createLatestBlob(), filename });
      api?.setToast({ message: t("singleFile.success.savedAs") });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      api?.setToast({ message: t("singleFile.errors.saveAsFailed") });
    }
  };

  return (
    <Excalidraw
      onExcalidrawAPI={setApi}
      initialData={initialPayload.scene}
      aiEnabled={false}
      isCollaborating={false}
      UIOptions={{ canvasActions: { export: {} } }}
    >
      <MainMenu>
        <MainMenu.Item
          icon={save}
          onSelect={onSave}
          data-testid="single-file-save"
        >
          {t("singleFile.save")}
        </MainMenu.Item>
        <MainMenu.Item
          icon={ExportIcon}
          onSelect={onSaveAs}
          data-testid="single-file-save-as"
        >
          {t("singleFile.saveAs")}
        </MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
};

createRoot(document.getElementById("root")!).render(<RuntimeApp />);
