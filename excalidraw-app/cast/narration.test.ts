import { describe, expect, it, vi } from "vitest";

import {
  acquireMicLock,
  getMicLockOwner,
} from "@excalidraw/excalidraw/voice/micLock";
import { VoiceRecorderFailure } from "@excalidraw/excalidraw/voice/recorder";

import type { VoiceRecorder } from "@excalidraw/excalidraw/voice/recorder";

import {
  CAST_NARRATION_MAX_DURATION,
  CastRecorder,
  InvalidCastScriptError,
  deserializeCastScript,
  serializeCastScript,
  startCastNarration,
  syncNarration,
} from "./index";

import type { CastNarrationV1, CastScriptV1 } from "./index";

const makeScript = (durationMs = 5000): CastScriptV1 => {
  let now = 0;
  const recorder = new CastRecorder({
    title: "Demo",
    appVersion: "test",
    clock: () => now,
    idFactory: () => "cast-1",
  });
  recorder.start({
    elements: [],
    files: {},
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  });
  now += durationMs;
  return recorder.stop({
    elements: [],
    files: {},
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  });
};

const narration = (
  overrides: Partial<CastNarrationV1> = {},
): CastNarrationV1 => ({
  mimeType: "audio/webm",
  dataURL: "data:audio/webm;base64,AAAA",
  offsetMs: 200,
  durationMs: 4000,
  ...overrides,
});

const fakeMedia = () => {
  const media = {
    currentTime: 0,
    paused: true,
    playbackRate: 1,
    pause: vi.fn(() => {
      media.paused = true;
    }),
    play: vi.fn(async () => {
      media.paused = false;
    }),
  };
  return media;
};

const fakeRecorder = (duration: number) => {
  const recorder = {
    track: {} as MediaStreamTrack,
    deviceId: null,
    elapsed: () => duration,
    level: () => 0,
    pause: vi.fn(),
    resume: vi.fn(),
    discard: vi.fn(),
    stop: vi.fn(async () => ({
      blob: new Blob(["voice"], { type: "audio/webm" }),
      mimeType: "audio/webm" as const,
      duration,
      peaks: [],
    })),
  };
  // type-checks the fake against the real recorder shape
  const typed: VoiceRecorder = recorder;
  return Object.assign(typed, recorder);
};

describe("Cast narration (ADR 0034 R5)", () => {
  it("round-trips inline audio and rejects anything else", () => {
    const script = { ...makeScript(), narration: narration() };
    expect(deserializeCastScript(serializeCastScript(script))).toEqual(script);
    // scripts without narration stay valid
    expect(() => serializeCastScript(makeScript())).not.toThrow();

    for (const bad of [
      narration({ dataURL: "https://example.com/a.webm" }),
      narration({ dataURL: "data:text/html;base64,AAAA" }),
      narration({ mimeType: "video/webm" }),
      narration({ offsetMs: 6000 }),
      narration({ durationMs: CAST_NARRATION_MAX_DURATION + 1 }),
      narration({ durationMs: -1 }),
    ]) {
      expect(() =>
        deserializeCastScript(
          JSON.stringify({ ...makeScript(), narration: bad }),
        ),
      ).toThrow(InvalidCastScriptError);
    }
  });

  it("follows the replay clock, re-seeking only on drift", () => {
    const media = fakeMedia();
    const track = narration({ offsetMs: 1000, durationMs: 3000 });

    // before the audio starts: silent
    syncNarration(media, track, { timeMs: 500, playing: true, speed: 1 });
    expect(media.play).not.toHaveBeenCalled();

    syncNarration(media, track, { timeMs: 1500, playing: true, speed: 2 });
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(media.currentTime).toBe(0.5);
    expect(media.playbackRate).toBe(2);

    // small drift is left alone so playback doesn't stutter
    media.currentTime = 0.6;
    syncNarration(media, track, { timeMs: 1700, playing: true, speed: 2 });
    expect(media.currentTime).toBe(0.6);
    media.currentTime = 2;
    syncNarration(media, track, { timeMs: 1700, playing: true, speed: 2 });
    expect(media.currentTime).toBe(0.7);

    // a paused scrub parks the audio where playback will resume
    syncNarration(media, track, { timeMs: 2500, playing: false, speed: 2 });
    expect(media.pause).toHaveBeenCalled();
    expect(media.currentTime).toBe(1.5);

    // past the end of the audio: silent
    media.paused = false;
    syncNarration(media, track, { timeMs: 4500, playing: true, speed: 1 });
    expect(media.paused).toBe(true);
  });

  it("refuses rather than preempting a busy microphone", () => {
    const release = acquireMicLock("voice-tool")!;
    const start = vi.fn();
    expect(
      startCastNarration({
        getScriptTime: () => 0,
        deviceId: null,
        onFailure: vi.fn(),
        onEnded: vi.fn(),
        start,
      }),
    ).toBeNull();
    expect(start).not.toHaveBeenCalled();
    release();
  });

  it("records from the script time the mic opened, honouring pauses", async () => {
    let scriptTime = 0;
    const recorder = fakeRecorder(3000);
    let resolveStart!: (value: VoiceRecorder) => void;
    const session = startCastNarration({
      getScriptTime: () => scriptTime,
      deviceId: "mic-1",
      onFailure: vi.fn(),
      onEnded: vi.fn(),
      start: vi.fn(
        () =>
          new Promise<VoiceRecorder>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    })!;
    expect(getMicLockOwner()).toBe("cast-narration");

    // paused while the permission prompt was up
    session.pause();
    scriptTime = 750;
    resolveStart(recorder);
    await Promise.resolve();
    expect(recorder.pause).toHaveBeenCalled();
    session.resume();
    expect(recorder.resume).toHaveBeenCalled();

    const result = await session.finish();
    expect(result).toMatchObject({
      mimeType: "audio/webm",
      offsetMs: 750,
      durationMs: 3000,
    });
    expect(result?.dataURL).toMatch(/^data:audio\/webm;base64,/);
    // finishing twice (time limit, then stop) records once
    expect(await session.finish()).toBe(result);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(getMicLockOwner()).toBeNull();
  });

  it("keeps the drawing going when the mic fails, and drops tiny clips", async () => {
    const onFailure = vi.fn();
    const failing = startCastNarration({
      getScriptTime: () => 0,
      deviceId: null,
      onFailure,
      onEnded: vi.fn(),
      start: async () => {
        throw new VoiceRecorderFailure("permission");
      },
    })!;
    expect(await failing.finish()).toBeNull();
    expect(onFailure).toHaveBeenCalledWith("permission");
    expect(getMicLockOwner()).toBeNull();

    const short = startCastNarration({
      getScriptTime: () => 0,
      deviceId: null,
      onFailure: vi.fn(),
      onEnded: vi.fn(),
      start: async () => fakeRecorder(400),
    })!;
    expect(await short.finish()).toBeNull();

    const discarded = fakeRecorder(5000);
    const session = startCastNarration({
      getScriptTime: () => 0,
      deviceId: null,
      onFailure: vi.fn(),
      onEnded: vi.fn(),
      start: async () => discarded,
    })!;
    await Promise.resolve();
    session.discard();
    expect(discarded.discard).toHaveBeenCalled();
    expect(await session.finish()).toBeNull();
    expect(getMicLockOwner()).toBeNull();
  });
});
