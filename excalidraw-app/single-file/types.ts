import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export const SINGLE_FILE_PAYLOAD_VERSION = 1 as const;
export const SINGLE_FILE_PAYLOAD_SCRIPT_ID = "calileon-single-file-payload";
export const SINGLE_FILE_PAYLOAD_PLACEHOLDER =
  "__CALILEON_SINGLE_FILE_PAYLOAD__";

export type SingleFilePayloadV1 = {
  version: typeof SINGLE_FILE_PAYLOAD_VERSION;
  createdAt: number;
  updatedAt: number;
  generator: {
    name: "Calileon";
    version: string;
  };
  document: {
    name: string;
  };
  scene: {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
  };
  capabilities: {
    editable: true;
    cloud: false;
    collaboration: false;
    ai: false;
  };
};

export type SingleFilePayload = SingleFilePayloadV1;
