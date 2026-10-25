import { act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";

import { render } from "@excalidraw/excalidraw/tests/test-utils";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";

import { acquireMicLock } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { commitArtwork, SynesthesiaSession } from "./session";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  analyser: {
    fftSize: 2048,
    frequencyBinCount: 1024,
    getFloatTimeDomainData: (a: Float32Array) => a.fill(0),
    getByteFrequencyData: (a: Uint8Array) => a.fill(150),
  },
}));
vi.mock("./audio", () => ({
  openAudio: vi.fn(async () => ({
    context: { sampleRate: 48000 },
    analyser: mocks.analyser,
    duration: 300,
    play: async () => {},
    dispose: mocks.dispose,
  })),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("session", () => {
  it("batches locally, stops at five minutes, and cleans once", async () => {
    vi.useFakeTimers();
    const preview = vi.fn();
    const finish = vi.fn();
    const session = new SynesthesiaSession({
      file: null,
      style: "blocks",
      area: { x: 0, y: 0, width: 500, height: 300 },
      dark: false,
      seed: 1,
      preview,
      finish,
    });
    await session.start();
    vi.advanceTimersByTime(149);
    expect(preview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preview).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300000);
    session.stop();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("inserts a group as one undo step without losing remote elements", async () => {
    let api!: ExcalidrawImperativeAPI;
    await render(
      <Excalidraw
        handleKeyboardGlobally
        onExcalidrawAPI={(value) => {
          if (value) {
            api = value;
          }
        }}
      />,
    );
    const remote = API.createElement({ type: "rectangle" });
    act(() =>
      api.updateScene({
        elements: [remote],
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
    const artwork = [
      API.createElement({ type: "ellipse", groupIds: ["session"] }),
      API.createElement({ type: "line", groupIds: ["session"] }),
    ];
    act(() => commitArtwork(api, artwork));
    expect(API.getUndoStack()).toHaveLength(1);
    act(() => commitArtwork(api, artwork));
    expect(API.getUndoStack()).toHaveLength(1);
    Keyboard.undo();
    expect(api.getSceneElements().map((e) => e.id)).toEqual([remote.id]);
    Keyboard.redo();
    expect(api.getSceneElements()).toHaveLength(3);
    act(() => commitArtwork(api, []));
    expect(API.getUndoStack()).toHaveLength(1);
  });
  it("refuses the microphone while a voice message records (ADR 0034)", async () => {
    const release = acquireMicLock("voice-recording")!;
    const finish = vi.fn();
    const session = new SynesthesiaSession({
      file: null,
      style: "blocks",
      area: { x: 0, y: 0, width: 500, height: 300 },
      dark: false,
      seed: 1,
      preview: vi.fn(),
      finish,
    });
    await session.start();
    expect(finish).toHaveBeenCalledWith([], "micBusy");
    release();

    // once free, the session holds the lock until it stops
    const next = new SynesthesiaSession({
      file: null,
      style: "blocks",
      area: { x: 0, y: 0, width: 500, height: 300 },
      dark: false,
      seed: 1,
      preview: vi.fn(),
      finish: vi.fn(),
    });
    await next.start();
    expect(acquireMicLock("voice-recording")).toBeNull();
    next.stop();
    const again = acquireMicLock("voice-recording");
    expect(again).not.toBeNull();
    again!();
  });
});
