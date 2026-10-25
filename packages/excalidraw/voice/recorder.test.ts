import {
  AUDIO_PEAKS_COUNT,
  AUDIO_RECORDING_MAX_DURATION,
} from "@excalidraw/common";

import { acquireMicLock, getMicLockOwner } from "./micLock";
import {
  VoiceRecorderFailure,
  levelsToPeaks,
  pickRecordingMimeType,
  startVoiceRecorder,
} from "./recorder";

const createEnv = (
  opts: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<any>;
    policy?: boolean;
    level?: number;
  } = {},
) => {
  let time = 0;
  const track = {
    stop: vi.fn(),
    onended: null as null | (() => void),
    getSettings: () => ({ deviceId: "mic-1" }),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported = (type: string) =>
      type === "audio/webm;codecs=opus";
    state: RecordingState = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public stream: unknown, public options: MediaRecorderOptions) {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["voice"]) });
      this.onstop?.();
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
  }
  class FakeAudioContext {
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createAnalyser = () => ({
      fftSize: 0,
      getFloatTimeDomainData: (array: Float32Array) =>
        array.fill(opts.level ?? 0.1),
    });
    close = vi.fn(async () => {});
  }
  const getUserMedia = vi.fn(opts.getUserMedia ?? (async () => stream));
  return {
    track,
    recorders,
    getUserMedia,
    advance: (ms: number) => {
      time += ms;
    },
    env: {
      mediaDevices: { getUserMedia },
      MediaRecorder: FakeRecorder as any,
      AudioContext: FakeAudioContext as any,
      isSecureContext: true,
      isMicrophoneAllowedByPolicy: () => opts.policy ?? true,
      now: () => time,
    },
  };
};

describe("voice recorder (ADR 0034 §4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers webm/opus and falls back to the browser default", () => {
    expect(pickRecordingMimeType((type) => type.startsWith("audio/webm"))).toBe(
      "audio/webm;codecs=opus",
    );
    expect(pickRecordingMimeType((type) => type === "audio/mp4")).toBe(
      "audio/mp4",
    );
    expect(pickRecordingMimeType(() => false)).toBe("");
  });

  it("turns sampled levels into AUDIO_PEAKS_COUNT normalized peaks", () => {
    expect(levelsToPeaks([])).toEqual(new Array(AUDIO_PEAKS_COUNT).fill(0));
    const peaks = levelsToPeaks([0, 0.1, 0.4, 0.1, 0]);
    expect(peaks).toHaveLength(AUDIO_PEAKS_COUNT);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
    // silence stays flat instead of being amplified to full height
    expect(Math.max(...levelsToPeaks([0.001, 0.002]))).toBeLessThan(0.3);
  });

  it("reports unsupported, blocked and permission failures", async () => {
    await expect(
      startVoiceRecorder({
        deviceId: null,
        env: { ...createEnv().env, isSecureContext: false },
      }),
    ).rejects.toMatchObject({ reason: "unsupported" });
    await expect(
      startVoiceRecorder({
        deviceId: null,
        env: createEnv({ policy: false }).env,
      }),
    ).rejects.toMatchObject({ reason: "blocked" });
    await expect(
      startVoiceRecorder({
        deviceId: null,
        env: createEnv({
          getUserMedia: async () => {
            throw new DOMException("", "NotAllowedError");
          },
        }).env,
      }),
    ).rejects.toBeInstanceOf(VoiceRecorderFailure);
  });

  it("falls back to the default mic when the remembered one is gone", async () => {
    const fake = createEnv();
    const stream = {
      getTracks: () => [fake.track],
      getAudioTracks: () => [fake.track],
    };
    fake.getUserMedia.mockImplementation(async (constraints: any) => {
      if (constraints.audio.deviceId) {
        throw new DOMException("", "OverconstrainedError");
      }
      return stream;
    });
    const recorder = await startVoiceRecorder({
      deviceId: "unplugged",
      env: fake.env,
    });
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(recorder.deviceId).toBe("mic-1");
    recorder.discard();
  });

  it("records at a low bitrate and resolves blob, duration and peaks", async () => {
    vi.useFakeTimers();
    const fake = createEnv();
    const recorder = await startVoiceRecorder({
      deviceId: null,
      env: fake.env,
    });
    expect(fake.recorders[0].options.audioBitsPerSecond).toBe(32_000);
    vi.advanceTimersByTime(500);
    fake.advance(2500);
    const recording = await recorder.stop();
    expect(recording.mimeType).toBe("audio/webm");
    expect(recording.blob.type).toBe("audio/webm");
    expect(recording.duration).toBe(2500);
    expect(recording.peaks).toHaveLength(AUDIO_PEAKS_COUNT);
    expect(fake.track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("auto-stops at the limit and caps the duration", async () => {
    vi.useFakeTimers();
    const fake = createEnv();
    const onAutoStop = vi.fn();
    const recorder = await startVoiceRecorder({
      deviceId: null,
      env: fake.env,
      onAutoStop,
    });
    fake.advance(AUDIO_RECORDING_MAX_DURATION + 500);
    vi.advanceTimersByTime(AUDIO_RECORDING_MAX_DURATION);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    const recording = await recorder.stop();
    expect(recording.duration).toBe(AUDIO_RECORDING_MAX_DURATION);
  });

  it("excludes paused time and pauses the time limit with it", async () => {
    vi.useFakeTimers();
    const fake = createEnv();
    const onAutoStop = vi.fn();
    const recorder = await startVoiceRecorder({
      deviceId: null,
      env: fake.env,
      maxDuration: 10_000,
      onAutoStop,
    });
    fake.advance(4000);
    vi.advanceTimersByTime(4000);
    recorder.pause();
    expect(fake.recorders[0].state).toBe("paused");
    expect(recorder.level()).toBe(0);

    // a long pause neither counts nor trips the limit
    fake.advance(20_000);
    vi.advanceTimersByTime(20_000);
    expect(recorder.elapsed()).toBe(4000);
    expect(onAutoStop).not.toHaveBeenCalled();

    recorder.resume();
    fake.advance(5000);
    vi.advanceTimersByTime(5000);
    expect(onAutoStop).not.toHaveBeenCalled();
    fake.advance(1000);
    vi.advanceTimersByTime(1000);
    expect(onAutoStop).toHaveBeenCalledTimes(1);

    const recording = await recorder.stop();
    expect(recording.duration).toBe(10_000);
  });

  it("discard releases the device without producing audio", async () => {
    const fake = createEnv();
    const recorder = await startVoiceRecorder({
      deviceId: null,
      env: fake.env,
    });
    recorder.discard();
    expect(fake.track.stop).toHaveBeenCalled();
    await expect(recorder.stop()).rejects.toBeInstanceOf(VoiceRecorderFailure);
  });

  it("reports a track that ends on its own", async () => {
    const fake = createEnv();
    const onInterrupted = vi.fn();
    const recorder = await startVoiceRecorder({
      deviceId: null,
      env: fake.env,
      onInterrupted,
    });
    fake.track.onended?.();
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    recorder.discard();
  });
});

describe("mic lock", () => {
  it("lets one owner hold the microphone and refuses others", () => {
    const release = acquireMicLock("voice-recording");
    expect(release).not.toBeNull();
    expect(getMicLockOwner()).toBe("voice-recording");
    expect(acquireMicLock("synesthesia")).toBeNull();
    release!();
    // releasing twice is harmless and doesn't free a later owner
    const next = acquireMicLock("synesthesia");
    release!();
    expect(getMicLockOwner()).toBe("synesthesia");
    next!();
    expect(getMicLockOwner()).toBeNull();
  });
});
