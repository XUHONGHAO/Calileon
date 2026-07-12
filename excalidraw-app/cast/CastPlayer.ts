import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { cloneCastValue } from "./normalize";

import type {
  CastAppStateSnapshot,
  CastEventV1,
  CastPlaybackPointer,
  CastPlaybackSnapshot,
  CastScriptV1,
} from "./types";

const applyEvent = (
  event: CastEventV1,
  elements: Map<string, ExcalidrawElement>,
  appState: CastAppStateSnapshot,
  files: BinaryFiles,
  pointer: CastPlaybackPointer | null,
) => {
  if (event.type === "scene") {
    for (const id of event.deletedElementIds) {
      elements.delete(id);
    }
    for (const element of event.changedElements) {
      elements.set(element.id, cloneCastValue(element));
    }
    Object.assign(files, cloneCastValue(event.addedFiles ?? {}));
    Object.assign(appState, cloneCastValue(event.appState ?? {}));
  } else if (event.type === "viewport") {
    Object.assign(appState, {
      scrollX: event.scrollX,
      scrollY: event.scrollY,
      zoom: event.zoom,
    });
  } else if (event.type === "pointer") {
    pointer = { x: event.x, y: event.y, visible: event.visible };
  }
  return pointer;
};

export class CastPlayer {
  public constructor(private readonly script: CastScriptV1) {}

  public getDurationMs() {
    return this.script.durationMs;
  }

  public seek(requestedAt: number): CastPlaybackSnapshot {
    const at = Math.max(0, Math.min(this.script.durationMs, requestedAt));
    const checkpoint = [...this.script.checkpoints]
      .filter((candidate) => candidate.at <= at)
      .sort((a, b) => b.at - a.at)[0];
    const base = checkpoint ?? {
      at: 0,
      eventIndex: 0,
      elements: this.script.initial.elements,
      appState: this.script.initial.appState,
      files: this.script.initial.files,
      pointer: null,
    };
    const elements = new Map(
      cloneCastValue(base.elements).map((element) => [element.id, element]),
    );
    const appState = cloneCastValue(base.appState);
    const files = cloneCastValue(base.files);
    let pointer = cloneCastValue(base.pointer);
    for (
      let index = base.eventIndex;
      index < this.script.events.length;
      index++
    ) {
      const event = this.script.events[index];
      if (event.at > at) {
        break;
      }
      pointer = applyEvent(event, elements, appState, files, pointer);
    }
    appState.luminaGameMode = undefined;
    delete appState.luminaGameMode;
    return {
      at,
      elements: [...elements.values()],
      appState,
      files,
      pointer,
    };
  }
}
