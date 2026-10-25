import { EDITOR_LS_KEYS } from "@excalidraw/common";

import {
  FakeRecognition,
  fakeRecognitionCtor,
} from "../tests/helpers/fakeSpeech";

import {
  TRANSCRIBER_FINISH_TIMEOUT,
  createTranscriber,
  getLocalSpeechAvailability,
  getRememberedSpeechPath,
  installLocalSpeech,
  rememberSpeechPath,
} from "./transcriber";

const BROWSER = "TestBrowser/1";

const fakeTrack = (readyState: MediaStreamTrackState = "live") =>
  ({ readyState } as MediaStreamTrack);

describe("createTranscriber (ADR 0034 §7)", () => {
  let level = 0;
  let clock = 0;

  const create = (
    overrides: Partial<Parameters<typeof createTranscriber>[0]> = {},
  ) =>
    createTranscriber({
      track: fakeTrack(),
      lang: "zh-CN",
      mode: "auto",
      getLevel: () => level,
      recognitionCtor: fakeRecognitionCtor,
      now: () => clock,
      browserKey: BROWSER,
      ...overrides,
    })!;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.reset();
    localStorage.removeItem(EDITOR_LS_KEYS.VOICE_SPEECH_PATHS);
    level = 0;
    clock = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null without a recognizer", () => {
    expect(create({ recognitionCtor: null })).toBeNull();
  });

  it("starts on the recorded track, continuous, with interim results", () => {
    const track = fakeTrack();
    const transcriber = create({ track });
    const recognition = FakeRecognition.last;
    expect(transcriber.path).toBe("track");
    expect(recognition.startedWith).toBe(track);
    expect(recognition).toMatchObject({
      lang: "zh-CN",
      continuous: true,
      interimResults: true,
    });
    expect(recognition.processLocally).toBeUndefined();
  });

  it("forces on-device recognition in local-only mode", () => {
    create({ mode: "local-only" });
    expect(FakeRecognition.last.processLocally).toBe(true);
  });

  it("reports cleaned finals and interim text, and keeps them across restarts", async () => {
    const updates: { final: string; interim: string }[] = [];
    const transcriber = create({ onUpdate: (update) => updates.push(update) });
    const first = FakeRecognition.last;
    first.emit("你 好", false);
    expect(updates.at(-1)).toEqual({ final: "", interim: "你好" });
    first.emit("你 好", true);
    first.emit("世", false);
    expect(updates.at(-1)).toEqual({ final: "你好", interim: "世" });

    // Chrome ends a continuous session after a pause; we restart
    clock = 5_000;
    first.end();
    expect(FakeRecognition.instances).toHaveLength(2);
    const second = FakeRecognition.last;
    second.emit("世 界", true);
    expect(updates.at(-1)).toEqual({ final: "你好世界", interim: "" });

    const result = transcriber.finish();
    expect(second.stopped).toBe(true);
    second.emit("再见", true);
    second.end();
    expect(await result).toBe("你好世界再见");
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("keeps the interim words when the last final never arrives", async () => {
    const transcriber = create();
    FakeRecognition.last.emit("hello", true);
    FakeRecognition.last.emit("world", false);
    const result = transcriber.finish();
    vi.advanceTimersByTime(TRANSCRIBER_FINISH_TIMEOUT);
    expect(await result).toBe("hello world");
    expect(FakeRecognition.last.aborted).toBe(true);
  });

  it("falls back to the default microphone when the track yields nothing", () => {
    const transcriber = create();
    const onTrack = FakeRecognition.last;
    level = 0.6;
    vi.advanceTimersByTime(3_000);
    expect(onTrack.aborted).toBe(true);
    expect(transcriber.path).toBe("default");
    const fallback = FakeRecognition.last;
    expect(fallback).not.toBe(onTrack);
    expect(fallback.startedWith).toBeUndefined();
    // remembered only once the new path actually produced text
    expect(getRememberedSpeechPath(BROWSER)).toBeNull();
    fallback.emit("ok", true);
    expect(getRememberedSpeechPath(BROWSER)).toBe("default");
  });

  it("falls back after repeated empty finals (Edge on path B)", () => {
    const transcriber = create();
    FakeRecognition.last.emit("", true);
    expect(transcriber.path).toBe("track");
    FakeRecognition.last.emit("", true);
    expect(transcriber.path).toBe("default");
  });

  it("doesn't fall back while it is quiet or once the path produced text", () => {
    const transcriber = create();
    level = 0.05;
    vi.advanceTimersByTime(10_000);
    expect(transcriber.path).toBe("track");

    FakeRecognition.last.emit("你好", true);
    level = 0.6;
    vi.advanceTimersByTime(10_000);
    expect(transcriber.path).toBe("track");
    expect(getRememberedSpeechPath(BROWSER)).toBe("track");
  });

  it("starts on the remembered path and only tries the other one once", () => {
    rememberSpeechPath("default", BROWSER);
    const transcriber = create();
    expect(transcriber.path).toBe("default");
    expect(FakeRecognition.last.startedWith).toBeUndefined();

    level = 0.6;
    vi.advanceTimersByTime(3_000);
    expect(transcriber.path).toBe("track");
    vi.advanceTimersByTime(10_000);
    expect(transcriber.path).toBe("track");
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("uses the default microphone when there is no track", () => {
    const transcriber = create({ track: null });
    expect(transcriber.path).toBe("default");
    expect(FakeRecognition.last.startedWith).toBeUndefined();
  });

  it("switches to start() when the browser rejects a track argument", () => {
    FakeRecognition.rejectTrack = true;
    const transcriber = create();
    expect(transcriber.path).toBe("default");
    expect(FakeRecognition.last.startedWith).toBeUndefined();
  });

  it("gives up on fatal errors and keeps what it heard", async () => {
    const onUnavailable = vi.fn();
    const transcriber = create({ onUnavailable });
    FakeRecognition.last.emit("hello", true);
    FakeRecognition.last.fail("network");
    FakeRecognition.last.end();
    expect(onUnavailable).toHaveBeenCalledWith("network");
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(await transcriber.finish()).toBe("hello");
  });

  it("stops restarting a recognizer that keeps ending at once", () => {
    create();
    for (let i = 0; i < 10; i++) {
      FakeRecognition.last.end();
    }
    expect(FakeRecognition.instances.length).toBeLessThanOrEqual(7);
  });

  it("abort returns the finals so far and stops listening", () => {
    const transcriber = create();
    FakeRecognition.last.emit("done", true);
    FakeRecognition.last.emit("and more", false);
    expect(transcriber.abort()).toBe("done");
    expect(FakeRecognition.last.aborted).toBe(true);
    FakeRecognition.last.end();
    expect(FakeRecognition.instances).toHaveLength(1);
  });
});

describe("on-device recognition", () => {
  beforeEach(() => FakeRecognition.reset());

  it("fails closed without the on-device API", async () => {
    expect(
      await getLocalSpeechAvailability(
        "zh-CN",
        {} as any as typeof fakeRecognitionCtor,
      ),
    ).toBe("unavailable");
    expect(await getLocalSpeechAvailability("zh-CN", null)).toBe("unavailable");
  });

  it("asks the browser and installs on request", async () => {
    FakeRecognition.availability = "downloadable";
    expect(await getLocalSpeechAvailability("zh-CN", fakeRecognitionCtor)).toBe(
      "downloadable",
    );
    expect(await installLocalSpeech("zh-CN", fakeRecognitionCtor)).toBe(true);
    expect(FakeRecognition.installCalls).toBe(1);
  });
});
