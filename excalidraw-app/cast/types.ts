import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export const CAST_SCRIPT_VERSION = 1 as const;

export type CastAppStateSnapshot = Record<string, unknown> & {
  scrollX: number;
  scrollY: number;
  zoom: number;
  luminaEnabled?: boolean;
  luminaAmbient?: number;
  luminaCaustics?: boolean;
};

export type CastSceneSnapshot = {
  elements: readonly ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: BinaryFiles;
};

export type CastSceneEventV1 = {
  type: "scene";
  at: number;
  changedElements: readonly ExcalidrawElement[];
  deletedElementIds: readonly string[];
  addedFiles?: BinaryFiles;
  appState?: Partial<CastAppStateSnapshot>;
};

export type CastViewportEventV1 = {
  type: "viewport";
  at: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
};

export type CastPointerEventV1 = {
  type: "pointer";
  at: number;
  x: number;
  y: number;
  visible: boolean;
};

export type CastMarkerEventV1 = {
  type: "marker";
  at: number;
  label?: string;
};

export type CastEventV1 =
  | CastSceneEventV1
  | CastViewportEventV1
  | CastPointerEventV1
  | CastMarkerEventV1;

export type CastCheckpointV1 = {
  at: number;
  eventIndex: number;
  elements: readonly ExcalidrawElement[];
  appState: CastAppStateSnapshot;
  files: BinaryFiles;
  pointer: CastPlaybackPointer | null;
};

export type CastScriptV1 = {
  version: typeof CAST_SCRIPT_VERSION;
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  initial: {
    elements: readonly ExcalidrawElement[];
    appState: CastAppStateSnapshot;
    files: BinaryFiles;
  };
  events: CastEventV1[];
  checkpoints: CastCheckpointV1[];
  metadata: {
    appVersion: string;
    locale?: string;
  };
};

export type CastRecorderState = "idle" | "recording" | "paused" | "stopped";

export type CastPlaybackPointer = {
  x: number;
  y: number;
  visible: boolean;
};

export type CastPlaybackSnapshot = {
  at: number;
  elements: readonly ExcalidrawElement[];
  appState: CastAppStateSnapshot;
  files: BinaryFiles;
  pointer: CastPlaybackPointer | null;
};
