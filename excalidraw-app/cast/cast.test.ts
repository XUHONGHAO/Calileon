import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  CastPlayer,
  CastRecorder,
  InvalidCastScriptError,
  UnsupportedCastVersionError,
  deserializeCastScript,
  emitCastPointerUpdate,
  forwardCastEditorPointerUpdate,
  saveCastScriptToCloud,
  serializeCastScript,
  subscribeCastPointerUpdate,
} from "./index";

import type { CloudBackend } from "../data/cloud";

const element = (
  id: string,
  version: number,
  customData?: Record<string, unknown>,
  type: ExcalidrawElement["type"] = "rectangle",
) =>
  ({
    id,
    type,
    x: version,
    y: 0,
    width: 10,
    height: 10,
    version,
    versionNonce: version,
    isDeleted: false,
    customData,
  } as ExcalidrawElement);

const file = (id: string) =>
  ({
    id,
    dataURL: "data:image/png;base64,AA==",
    mimeType: "image/png",
    created: 1,
  } as BinaryFiles[string]);

const snapshot = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles = {},
  appState: Record<string, unknown> = {},
) => ({
  elements,
  files,
  appState: {
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    ...appState,
  },
});

const setup = (checkpointSceneEventInterval = 200) => {
  let now = 1_000;
  const recorder = new CastRecorder({
    title: "Demo",
    appVersion: "test",
    clock: () => now,
    idFactory: () => "cast-1",
    pointerThrottleMs: 20,
    viewportThrottleMs: 20,
    checkpointSceneEventInterval,
  });
  return { recorder, advance: (ms: number) => (now += ms) };
};

describe("Cast semantic core", () => {
  it("serializes JSON-safe v1 scripts and rejects unknown versions", () => {
    const { recorder, advance } = setup();
    recorder.start(snapshot([element("a", 1)]));
    advance(10);
    recorder.addMarker("chapter");
    const script = recorder.stop();
    expect(deserializeCastScript(serializeCastScript(script))).toEqual(script);
    expect(() =>
      deserializeCastScript(JSON.stringify({ ...script, version: 2 })),
    ).toThrow(UnsupportedCastVersionError);
    expect(() =>
      deserializeCastScript(
        JSON.stringify({
          version: 1,
          id: "bad",
          title: "bad",
          createdAt: 0,
          durationMs: 0,
          initial: {},
          events: [],
          checkpoints: [],
          metadata: { appVersion: "test" },
        }),
      ),
    ).toThrow(InvalidCastScriptError);
    expect(() =>
      deserializeCastScript(
        JSON.stringify({
          ...script,
          events: [
            {
              type: "pointer",
              at: script.durationMs + 1,
              x: 1,
              y: 2,
              visible: true,
            },
          ],
        }),
      ),
    ).toThrow(InvalidCastScriptError);
  });

  it("uses active time while paused", () => {
    const { recorder, advance } = setup();
    recorder.start(snapshot([]));
    advance(100);
    recorder.pause();
    advance(5_000);
    expect(recorder.recordPointer({ x: 1, y: 1, visible: true })).toBeNull();
    recorder.resume();
    advance(50);
    expect(recorder.addMarker().at).toBe(150);
    expect(recorder.stop().durationMs).toBe(150);
  });

  it("records scene diffs, file additions once, and restores scene/files", () => {
    const { recorder, advance } = setup();
    recorder.start(snapshot([element("a", 1)]));
    advance(10);
    recorder.recordScene(
      snapshot([element("a", 2), element("b", 1)], { image: file("image") }),
    );
    advance(10);
    const event = recorder.recordScene(
      snapshot([element("b", 2)], { image: file("image") }),
    );
    const script = recorder.stop();
    expect(
      script.events.filter((candidate) => candidate.type === "scene"),
    ).toHaveLength(2);
    expect(event).toMatchObject({ deletedElementIds: ["a"] });
    expect(event?.addedFiles).toBeUndefined();
    const final = new CastPlayer(script).seek(script.durationMs);
    expect(final.elements.map((candidate) => candidate.id)).toEqual(["b"]);
    expect(final.elements[0].version).toBe(2);
    expect(final.files.image).toEqual(file("image"));
  });

  it("throttles and deduplicates pointer/viewport events and replays them", () => {
    const { recorder, advance } = setup();
    recorder.start(snapshot([]));
    expect(
      recorder.recordPointer({ x: 2, y: 3, visible: true }),
    ).not.toBeNull();
    expect(recorder.recordPointer({ x: 2, y: 3, visible: true })).toBeNull();
    advance(25);
    expect(
      recorder.recordPointer({ x: 4, y: 5, visible: false }),
    ).not.toBeNull();
    expect(
      recorder.recordViewport({ scrollX: 10, scrollY: 20, zoom: 2 }),
    ).not.toBeNull();
    expect(
      recorder.recordViewport({ scrollX: 10, scrollY: 20, zoom: 2 }),
    ).toBeNull();
    const final = new CastPlayer(recorder.stop()).seek(25);
    expect(final.pointer).toEqual({ x: 4, y: 5, visible: false });
    expect(final.appState).toMatchObject({ scrollX: 10, scrollY: 20, zoom: 2 });
  });

  it("seeks from checkpoints to the same result", () => {
    const { recorder, advance } = setup(1);
    recorder.start(snapshot([element("a", 1)]));
    advance(10);
    recorder.recordScene(snapshot([element("a", 2)]));
    expect(recorder.getDraft()?.checkpoints).toHaveLength(1);
    advance(10);
    recorder.recordScene(snapshot([element("a", 3)]));
    const script = recorder.stop();
    expect(new CastPlayer(script).seek(20).elements[0].version).toBe(3);
  });

  it("preserves portable element semantics and strips all game state", () => {
    const { recorder } = setup();
    recorder.start(
      snapshot(
        [
          element("light", 1, {
            luminaMaterial: { material: "glass" },
            luminaLight: { light: "point", intensity: 1 },
            luminaGame: { role: "target" },
          }),
          element(
            "blocked-arrow",
            1,
            { lineTone: { version: 1, tone: "blocked" } },
            "arrow",
          ),
        ],
        {},
        {
          luminaEnabled: true,
          luminaAmbient: 0.4,
          luminaCaustics: true,
          luminaGameMode: "laser",
        },
      ),
    );
    const script = recorder.stop();
    expect(script.initial.elements[0].customData).toEqual({
      luminaMaterial: { material: "glass" },
      luminaLight: { light: "point", intensity: 1 },
    });
    expect(script.initial.elements[1].customData).toEqual({
      lineTone: { version: 1, tone: "blocked" },
    });
    expect(script.initial.appState).toMatchObject({
      luminaEnabled: true,
      luminaAmbient: 0.4,
      luminaCaustics: true,
    });
    expect(script.initial.appState).not.toHaveProperty("luminaGameMode");
  });

  it("publishes pointer runtime updates", () => {
    const updates: unknown[] = [];
    const unsubscribe = subscribeCastPointerUpdate((update) =>
      updates.push(update),
    );
    emitCastPointerUpdate({ pointer: { x: 1, y: 2 }, button: "down" });
    unsubscribe();
    emitCastPointerUpdate({ pointer: { x: 3, y: 4 } });
    expect(updates).toEqual([{ pointer: { x: 1, y: 2 }, button: "down" }]);
  });

  it("filters editor laser pointers before they reach CastScript", () => {
    const updates: unknown[] = [];
    const unsubscribe = subscribeCastPointerUpdate((update) =>
      updates.push(update),
    );
    expect(
      forwardCastEditorPointerUpdate({
        pointer: { x: 1, y: 2, tool: "laser" },
        button: "down",
      }),
    ).toBe(false);
    expect(
      forwardCastEditorPointerUpdate({
        pointer: { x: 3, y: 4, tool: "pointer" },
        button: "up",
      }),
    ).toBe(true);
    unsubscribe();
    expect(updates).toEqual([
      {
        pointer: { x: 3, y: 4 },
        button: "up",
        visible: true,
      },
    ]);
  });

  it("handles a five-minute sampled recording without full-scene frames", () => {
    const { recorder, advance } = setup(200);
    recorder.start(snapshot([]));
    for (let index = 1; index <= 6_000; index++) {
      advance(50);
      recorder.recordPointer({
        x: index % 1_000,
        y: index % 600,
        visible: true,
      });
      if (index % 5 === 0) {
        recorder.recordViewport({
          scrollX: index,
          scrollY: -index,
          zoom: 1 + (index % 4) * 0.1,
        });
      }
      if (index % 20 === 0) {
        recorder.recordScene(snapshot([element("animated", index / 20)]));
      }
    }
    const script = recorder.stop();
    expect(script.durationMs).toBe(300_000);
    expect(script.checkpoints.length).toBeGreaterThan(0);
    expect(script.events.length).toBeLessThan(8_000);
  });

  it("saves scripts through the frozen manual cloud sequence", async () => {
    const { recorder } = setup();
    recorder.start(snapshot([]));
    const script = recorder.stop();
    const order: string[] = [];
    const createSession = vi.fn(async () => {
      order.push("session");
      return { id: "session-1" };
    });
    const upload = vi.fn(async () => {
      order.push("asset");
      return { id: "asset-1" };
    });
    const attachScript = vi.fn(async () => {
      order.push("attach");
      return { id: "session-1", status: "ready" };
    });
    const backend = {
      cast: { createSession, attachScript },
      assets: { upload },
    } as unknown as CloudBackend;

    await saveCastScriptToCloud({ backend, sceneId: "scene-1", script });

    expect(order).toEqual(["session", "asset", "attach"]);
    expect(createSession).toHaveBeenCalledWith({
      sceneId: "scene-1",
      title: "Demo",
      durationMs: 0,
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "recording",
        sceneId: "scene-1",
        fileId: "cast-session-1.calileon-cast.json",
        mimeType: "application/json",
      }),
    );
    expect(attachScript).toHaveBeenCalledWith("session-1", {
      scriptAssetId: "asset-1",
      durationMs: 0,
    });
  });
});
