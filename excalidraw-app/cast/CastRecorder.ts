import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { CastPlayer } from "./CastPlayer";
import {
  cloneCastValue,
  normalizeCastAppState,
  sanitizeCastElement,
  sanitizeCastFiles,
  sanitizeCastSnapshot,
} from "./normalize";
import {
  CAST_SCRIPT_VERSION,
  type CastMarkerEventV1,
  type CastPointerEventV1,
  type CastRecorderState,
  type CastSceneEventV1,
  type CastSceneSnapshot,
  type CastScriptV1,
  type CastViewportEventV1,
} from "./types";

export type CastRecorderOptions = {
  title: string;
  appVersion: string;
  locale?: string;
  clock?: () => number;
  idFactory?: () => string;
  pointerThrottleMs?: number;
  viewportThrottleMs?: number;
  checkpointIntervalMs?: number;
  checkpointSceneEventInterval?: number;
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export class CastRecorder {
  private state: CastRecorderState = "idle";
  private script: CastScriptV1 | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private elementCache = new Map<string, ExcalidrawElement>();
  private fileIds = new Set<string>();
  private appStateCache: Record<string, unknown> = {};
  private lastPointer: Omit<CastPointerEventV1, "type" | "at"> | null = null;
  private lastPointerAt = -Infinity;
  private lastViewport: Omit<CastViewportEventV1, "type" | "at"> | null = null;
  private lastViewportAt = -Infinity;
  private lastCheckpointAt = 0;
  private sceneEventsSinceCheckpoint = 0;

  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly pointerThrottleMs: number;
  private readonly viewportThrottleMs: number;
  private readonly checkpointIntervalMs: number;
  private readonly checkpointSceneEventInterval: number;

  public constructor(private readonly options: CastRecorderOptions) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.pointerThrottleMs = options.pointerThrottleMs ?? 32;
    this.viewportThrottleMs = options.viewportThrottleMs ?? 50;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 10_000;
    this.checkpointSceneEventInterval =
      options.checkpointSceneEventInterval ?? 200;
  }

  public getState() {
    return this.state;
  }

  public getElapsedMs() {
    if (this.state === "idle") {
      return 0;
    }
    const now = this.state === "paused" ? this.pausedAt : this.clock();
    return Math.max(0, now - this.startedAt - this.pausedTotal);
  }

  public start(snapshot: CastSceneSnapshot) {
    if (this.state !== "idle") {
      throw new Error("CastRecorder can only be started once");
    }
    const createdAt = this.clock();
    const initial = sanitizeCastSnapshot(snapshot);
    this.startedAt = createdAt;
    this.elementCache = new Map(
      initial.elements.map((element) => [element.id, element]),
    );
    this.fileIds = new Set(Object.keys(initial.files));
    this.appStateCache = cloneCastValue(initial.appState);
    this.script = {
      version: CAST_SCRIPT_VERSION,
      id: this.idFactory(),
      title: this.options.title,
      createdAt,
      durationMs: 0,
      initial,
      events: [],
      checkpoints: [],
      metadata: {
        appVersion: this.options.appVersion,
        ...(this.options.locale ? { locale: this.options.locale } : {}),
      },
    };
    this.state = "recording";
  }

  public pause() {
    this.assertState("recording");
    this.pausedAt = this.clock();
    this.state = "paused";
  }

  public resume(snapshot?: CastSceneSnapshot) {
    this.assertState("paused");
    this.pausedTotal += this.clock() - this.pausedAt;
    this.state = "recording";
    if (snapshot) {
      this.resetCaches(snapshot);
    }
  }

  public stop(snapshot?: CastSceneSnapshot): CastScriptV1 {
    if (this.state === "recording" && snapshot) {
      this.recordScene(snapshot);
    }
    if (this.state !== "recording" && this.state !== "paused") {
      throw new Error(`Cannot stop CastRecorder from ${this.state}`);
    }
    const script = this.requireScript();
    script.durationMs = this.getElapsedMs();
    this.state = "stopped";
    return cloneCastValue(script);
  }

  public recordScene(snapshot: CastSceneSnapshot): CastSceneEventV1 | null {
    if (this.state !== "recording") {
      return null;
    }
    const at = this.getElapsedMs();
    const elements = snapshot.elements.map(sanitizeCastElement);
    const current = new Map(elements.map((element) => [element.id, element]));
    const changedElements = elements.filter(
      (element) =>
        !this.elementCache.has(element.id) ||
        !same(this.elementCache.get(element.id), element),
    );
    const deletedElementIds = [...this.elementCache.keys()].filter(
      (id) => !current.has(id),
    );
    const addedFiles = Object.fromEntries(
      Object.entries(snapshot.files)
        .filter(([id]) => !this.fileIds.has(id))
        .map(([id, file]) => [id, cloneCastValue(file)]),
    ) as BinaryFiles;
    const appState = normalizeCastAppState(snapshot.appState);
    const appStateDelta = Object.fromEntries(
      Object.entries(appState).filter(
        ([key, value]) => !same(this.appStateCache[key], value),
      ),
    );
    this.elementCache = current;
    Object.keys(addedFiles).forEach((id) => this.fileIds.add(id));
    this.appStateCache = cloneCastValue(appState);
    if (
      changedElements.length === 0 &&
      deletedElementIds.length === 0 &&
      Object.keys(addedFiles).length === 0 &&
      Object.keys(appStateDelta).length === 0
    ) {
      return null;
    }
    const event: CastSceneEventV1 = {
      type: "scene",
      at,
      changedElements,
      deletedElementIds,
      ...(Object.keys(addedFiles).length
        ? { addedFiles: sanitizeCastFiles(addedFiles) }
        : {}),
      ...(Object.keys(appStateDelta).length ? { appState: appStateDelta } : {}),
    };
    this.requireScript().events.push(event);
    this.sceneEventsSinceCheckpoint++;
    this.maybeCheckpoint(at);
    return cloneCastValue(event);
  }

  public recordViewport(viewport: {
    scrollX: number;
    scrollY: number;
    zoom: number;
  }) {
    if (this.state !== "recording") {
      return null;
    }
    const at = this.getElapsedMs();
    if (
      same(this.lastViewport, viewport) ||
      at - this.lastViewportAt < this.viewportThrottleMs
    ) {
      return null;
    }
    const event: CastViewportEventV1 = { type: "viewport", at, ...viewport };
    this.lastViewport = viewport;
    this.lastViewportAt = at;
    Object.assign(this.appStateCache, viewport);
    this.requireScript().events.push(event);
    return cloneCastValue(event);
  }

  public recordPointer(pointer: { x: number; y: number; visible: boolean }) {
    if (this.state !== "recording") {
      return null;
    }
    const at = this.getElapsedMs();
    if (
      same(this.lastPointer, pointer) ||
      at - this.lastPointerAt < this.pointerThrottleMs
    ) {
      return null;
    }
    const event: CastPointerEventV1 = { type: "pointer", at, ...pointer };
    this.lastPointer = pointer;
    this.lastPointerAt = at;
    this.requireScript().events.push(event);
    return cloneCastValue(event);
  }

  public addMarker(label?: string): CastMarkerEventV1 {
    this.assertState("recording");
    const event: CastMarkerEventV1 = {
      type: "marker",
      at: this.getElapsedMs(),
      ...(label ? { label } : {}),
    };
    this.requireScript().events.push(event);
    return cloneCastValue(event);
  }

  public getDraft() {
    return this.script ? cloneCastValue(this.script) : null;
  }

  private resetCaches(snapshot: CastSceneSnapshot) {
    const normalized = sanitizeCastSnapshot(snapshot);
    this.elementCache = new Map(
      normalized.elements.map((element) => [element.id, element]),
    );
    this.fileIds = new Set(Object.keys(normalized.files));
    this.appStateCache = cloneCastValue(normalized.appState);
  }

  private maybeCheckpoint(at: number) {
    if (
      at - this.lastCheckpointAt < this.checkpointIntervalMs &&
      this.sceneEventsSinceCheckpoint < this.checkpointSceneEventInterval
    ) {
      return;
    }
    const script = this.requireScript();
    const snapshot = new CastPlayer({ ...script, durationMs: at }).seek(at);
    script.checkpoints.push({
      at,
      eventIndex: script.events.length,
      elements: snapshot.elements,
      appState: snapshot.appState,
      files: snapshot.files,
      pointer: snapshot.pointer,
    });
    this.lastCheckpointAt = at;
    this.sceneEventsSinceCheckpoint = 0;
  }

  private assertState(state: CastRecorderState) {
    if (this.state !== state) {
      throw new Error(
        `Expected CastRecorder state ${state}, got ${this.state}`,
      );
    }
  }

  private requireScript() {
    if (!this.script) {
      throw new Error("CastRecorder has not been started");
    }
    return this.script;
  }
}
