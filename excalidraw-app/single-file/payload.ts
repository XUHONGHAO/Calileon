import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { SINGLE_FILE_PAYLOAD_VERSION, type SingleFilePayloadV1 } from "./types";

const filterReferencedFiles = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
): BinaryFiles => {
  const referencedFiles: BinaryFiles = {};

  for (const element of elements) {
    if (
      !element.isDeleted &&
      "fileId" in element &&
      element.fileId &&
      files[element.fileId]
    ) {
      referencedFiles[element.fileId] = files[element.fileId];
    }
  }

  return referencedFiles;
};

export const createSingleFilePayload = ({
  elements,
  appState,
  files,
  name,
  generatorVersion,
  createdAt = Date.now(),
  updatedAt = createdAt,
}: {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  name: string;
  generatorVersion: string;
  createdAt?: number;
  updatedAt?: number;
}): SingleFilePayloadV1 => ({
  version: SINGLE_FILE_PAYLOAD_VERSION,
  createdAt,
  updatedAt,
  generator: {
    name: "Calileon",
    version: generatorVersion,
  },
  document: {
    name,
  },
  scene: {
    elements,
    appState: {
      ...cleanAppStateForExport(appState),
      name,
      theme: appState.theme,
    },
    files: filterReferencedFiles(elements, files),
  },
  capabilities: {
    editable: true,
    cloud: false,
    collaboration: false,
    ai: false,
  },
});

export const isSingleFilePayload = (
  value: unknown,
): value is SingleFilePayloadV1 => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<SingleFilePayloadV1>;
  return (
    payload.version === SINGLE_FILE_PAYLOAD_VERSION &&
    payload.generator?.name === "Calileon" &&
    payload.capabilities?.editable === true &&
    payload.capabilities.cloud === false &&
    payload.capabilities.collaboration === false &&
    payload.capabilities.ai === false &&
    Array.isArray(payload.scene?.elements) &&
    !!payload.scene?.appState &&
    !!payload.scene?.files
  );
};
