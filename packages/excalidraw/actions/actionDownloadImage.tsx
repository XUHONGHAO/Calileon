import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawImageElement } from "@excalidraw/element/types";

import { ToolButton } from "../components/ToolButton";
import { downloadIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

import type { AppClassProperties, AppState, DataURL } from "../types";

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

export const getImageDownloadExtension = (mimeType: string | undefined) => {
  if (!mimeType) {
    return "png";
  }

  const normalized = mimeType.split(";")[0].trim().toLowerCase();

  return MIME_TYPE_EXTENSIONS[normalized] || "png";
};

export const getImageDownloadFileName = (
  mimeType: string | undefined,
  createdAt: number,
) => {
  return `image-${createdAt}.${getImageDownloadExtension(mimeType)}`;
};

/**
 * Triggers a browser download for a data URL. Mirrors the workbench helper so
 * canvas images save with the same file-name conventions.
 */
export const downloadImageDataURL = (dataURL: DataURL, fileName: string) => {
  const anchor = document.createElement("a");

  anchor.href = dataURL;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export const getSelectedImageElement = (
  appState: Pick<AppState, "selectedElementIds">,
  app: Pick<AppClassProperties, "scene">,
) => {
  const selectedElements = app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
    includeBoundTextElement: false,
  });

  if (selectedElements.length !== 1) {
    return null;
  }

  const [element] = selectedElements;

  return isImageElement(element) ? (element as ExcalidrawImageElement) : null;
};

export const actionDownloadImage = register({
  name: "downloadImage",
  label: "buttons.downloadImage",
  icon: downloadIcon,
  viewMode: true,
  trackEvent: { category: "element" },
  keywords: ["image", "download", "save", "export"],
  predicate: (elements, appState, _, app) => {
    return !!getSelectedImageElement(appState, app);
  },
  perform: (elements, appState, _, app) => {
    const element = getSelectedImageElement(appState, app);

    if (!element || !isInitializedImageElement(element)) {
      return false;
    }

    const file = app.files[element.fileId];

    if (!file) {
      return false;
    }

    downloadImageDataURL(
      file.dataURL,
      getImageDownloadFileName(file.mimeType, element.created),
    );

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
  PanelComponent: ({ updateData }) => {
    const label = t("buttons.downloadImage");

    return (
      <ToolButton
        type="button"
        icon={downloadIcon}
        title={label}
        aria-label={label}
        onClick={() => updateData(null)}
      />
    );
  },
});
