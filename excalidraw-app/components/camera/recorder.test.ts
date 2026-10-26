import {
  VIDEO_MAX_BYTES,
  VIDEO_RECORDING_MAX_DURATION,
} from "@excalidraw/common";
import {
  acquireMicLock,
  getMicLockOwner,
} from "@excalidraw/excalidraw/voice/micLock";

import {
  CAMERA_MIC_LOCK_OWNER,
  fitWithin,
  getBaseVideoMimeType,
  getRecordingProblem,
  listMediaDevices,
  openCamera,
  pickVideoMimeType,
  startVideoRecording,
} from "./recorder";

type FakeTrack = {
  kind: "video" | "audio";
  stop: ReturnType<typeof vi.fn>;
  onended: null | (() => void);
  getSettings: () => Record<string, unknown>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  fire: () => void;
};

const createTrack = (
  kind: "video" | "audio",
  settings: Record<string, unknown> = {},
): FakeTrack => {
  const listeners = new Set<() => void>();
  const track: FakeTrack = {
    kind,
    stop: vi.fn(),
    onended: null,
    getSettings: () => settings,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fire: () => {
      track.onended?.();
      listeners.forEach((listener) => listener());
    },
  };
  return track;
};

const streamOf = (...tracks: FakeTrack[]) => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
});

const createEnv = (
  opts: {
    supported?: (type: string) => boolean;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<any>;
    policy?: (feature: string) => boolean;
    chunk?: Blob;
    recorderMimeType?: string;
    lock?: (owner: string) => (() => void) | null;
  } = {},
) => {
  let time = 0;
  const camTrack = createTrack("video", {
    deviceId: "cam-1",
    facingMode: "user",
  });
  const micTrack = createTrack("audio", { deviceId: "mic-1" });
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported =
      opts.supported ??
      ((type: string) => type === "video/webm;codecs=vp9,opus");
    state: RecordingState = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstart: (() => void) | null = null;
    onstop: ((event?: Event) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public stream: any, public options: MediaRecorderOptions) {
      this.mimeType = opts.recorderMimeType ?? options.mimeType ?? "";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: opts.chunk ?? new Blob(["frames"]) });
      this.onstop?.();
    }
    emit(data: Blob) {
      this.ondataavailable?.({ data });
    }
  }
  class FakeStream {
    constructor(public tracks: FakeTrack[]) {}
  }
  const getUserMedia = vi.fn(
    opts.getUserMedia ??
      (async (constraints: MediaStreamConstraints) =>
        constraints.video ? streamOf(camTrack) : streamOf(micTrack)),
  );
  return {
    camTrack,
    micTrack,
    recorders,
    getUserMedia,
    advance: (ms: number) => {
      time += ms;
    },
    env: {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () =>
          [
            { kind: "videoinput", deviceId: "cam-1", label: "Front" },
            { kind: "videoinput", deviceId: "", label: "" },
            { kind: "audioinput", deviceId: "mic-1", label: "Mic" },
          ] as MediaDeviceInfo[],
      },
      MediaRecorder: FakeRecorder as any,
      MediaStream: FakeStream as any,
      isSecureContext: true,
      isAllowedByPolicy: opts.policy ?? (() => true),
      acquireMicLock: opts.lock ?? acquireMicLock,
      now: () => time,
    },
  };
};

describe("camera recorder (ADR 0035 §5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers mp4/h264, then webm, and stores base mime types only", () => {
    expect(pickVideoMimeType(() => true)).toBe(
      "video/mp4;codecs=avc1,mp4a.40.2",
    );
    expect(pickVideoMimeType((type) => type.startsWith("video/webm"))).toBe(
      "video/webm;codecs=vp9,opus",
    );
    expect(pickVideoMimeType(() => false)).toBe("");
    expect(getBaseVideoMimeType("video/mp4;codecs=avc1")).toBe("video/mp4");
    expect(getBaseVideoMimeType("video/x-matroska;codecs=avc1")).toBeNull();
  });

  it("reports unsupported, blocked and permission failures", async () => {
    const { env } = createEnv();
    await expect(
      openCamera({ deviceId: null, env: { ...env, isSecureContext: false } }),
    ).rejects.toMatchObject({ reason: "unsupported" });
    await expect(
      openCamera({
        deviceId: null,
        env: { ...env, isAllowedByPolicy: (f) => f !== "camera" },
      }),
    ).rejects.toMatchObject({ reason: "blocked" });
    const denied = createEnv({
      getUserMedia: async () => {
        throw Object.assign(new Error(""), { name: "NotAllowedError" });
      },
    });
    await expect(
      openCamera({ deviceId: null, env: denied.env }),
    ).rejects.toMatchObject({ reason: "permission" });
    const busy = createEnv({
      getUserMedia: async () => {
        throw Object.assign(new Error(""), { name: "NotReadableError" });
      },
    });
    await expect(
      openCamera({ deviceId: null, env: busy.env }),
    ).rejects.toMatchObject({ reason: "busy" });
  });

  it("falls back to the default camera when the remembered one is gone", async () => {
    const camTrack = createTrack("video", { deviceId: "cam-2" });
    const { env, getUserMedia } = createEnv({
      getUserMedia: async (constraints: any) => {
        if (constraints.video?.deviceId) {
          throw Object.assign(new Error(""), { name: "OverconstrainedError" });
        }
        return streamOf(camTrack);
      },
    });
    const camera = await openCamera({ deviceId: "unplugged", env });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(camera.deviceId).toBe("cam-2");
    camera.close();
    expect(camTrack.stop).toHaveBeenCalled();
  });

  it("records the camera only, without touching the mic by default", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    expect(camera.facingMode).toBe("user");
    const session = await startVideoRecording({
      camera,
      withAudio: false,
      micDeviceId: null,
      env: harness.env,
    });
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(getMicLockOwner()).toBeNull();
    expect(harness.recorders[0].stream.tracks).toEqual([harness.camTrack]);
    expect(harness.recorders[0].options).toMatchObject({
      mimeType: "video/webm;codecs=vp9,opus",
      videoBitsPerSecond: 2_000_000,
    });
    harness.advance(4_200);
    const recording = await session.stop();
    expect(recording).toMatchObject({
      mimeType: "video/webm",
      duration: 4_200,
      hasAudio: false,
    });
    expect(recording.blob.type).toBe("video/webm");
    // the preview keeps running for a retake
    expect(harness.camTrack.stop).not.toHaveBeenCalled();
  });

  it("locks the mic while recording with sound and releases it after", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    const session = await startVideoRecording({
      camera,
      withAudio: true,
      micDeviceId: "mic-1",
      env: harness.env,
    });
    expect(getMicLockOwner()).toBe(CAMERA_MIC_LOCK_OWNER);
    expect(harness.recorders[0].stream.tracks).toEqual([
      harness.camTrack,
      harness.micTrack,
    ]);
    harness.advance(2_000);
    const recording = await session.stop();
    expect(recording.hasAudio).toBe(true);
    expect(getMicLockOwner()).toBeNull();
    expect(harness.micTrack.stop).toHaveBeenCalled();
    expect(harness.camTrack.stop).not.toHaveBeenCalled();
  });

  it("refuses sound while another feature holds the mic", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    const release = acquireMicLock("voice-tool")!;
    try {
      await expect(
        startVideoRecording({
          camera,
          withAudio: true,
          micDeviceId: null,
          env: harness.env,
        }),
      ).rejects.toMatchObject({ reason: "micBusy" });
      expect(getMicLockOwner()).toBe("voice-tool");
    } finally {
      release();
    }
  });

  it("releases the mic lock when the microphone can't be opened", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    harness.getUserMedia.mockImplementation(async () => {
      throw Object.assign(new Error(""), { name: "NotAllowedError" });
    });
    await expect(
      startVideoRecording({
        camera,
        withAudio: true,
        micDeviceId: null,
        env: harness.env,
      }),
    ).rejects.toMatchObject({ reason: "micUnavailable" });
    expect(getMicLockOwner()).toBeNull();
  });

  it("reports recorderUnsupported when no candidate type works", async () => {
    const harness = createEnv({ supported: () => false });
    const camera = await openCamera({ deviceId: null, env: harness.env });
    await expect(
      startVideoRecording({
        camera,
        withAudio: false,
        micDeviceId: null,
        env: harness.env,
      }),
    ).rejects.toMatchObject({ reason: "recorderUnsupported" });
  });

  it("auto-stops at 30 s and near the size cap", async () => {
    vi.useFakeTimers();
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    const onAutoStop = vi.fn();
    const session = await startVideoRecording({
      camera,
      withAudio: false,
      micDeviceId: null,
      onAutoStop,
      env: harness.env,
    });
    vi.advanceTimersByTime(VIDEO_RECORDING_MAX_DURATION - 1);
    expect(onAutoStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    harness.advance(VIDEO_RECORDING_MAX_DURATION + 500);
    expect(session.elapsed()).toBe(VIDEO_RECORDING_MAX_DURATION);
    session.discard();

    const big = await startVideoRecording({
      camera,
      withAudio: false,
      micDeviceId: null,
      onAutoStop,
      env: harness.env,
    });
    harness.recorders[1].emit(new Blob([new Uint8Array(VIDEO_MAX_BYTES)]));
    expect(onAutoStop).toHaveBeenCalledTimes(2);
    big.discard();
  });

  it("discard drops the take, ends the session and keeps the camera", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    const onInterrupted = vi.fn();
    const session = await startVideoRecording({
      camera,
      withAudio: true,
      micDeviceId: null,
      onInterrupted,
      env: harness.env,
    });
    session.discard();
    expect(getMicLockOwner()).toBeNull();
    await expect(session.stop()).rejects.toMatchObject({
      reason: "cameraError",
    });
    // listeners were removed with the session
    harness.camTrack.fire();
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(harness.camTrack.stop).not.toHaveBeenCalled();
  });

  it("reports an interrupted recording when a track ends", async () => {
    const harness = createEnv();
    const camera = await openCamera({ deviceId: null, env: harness.env });
    const onInterrupted = vi.fn();
    const session = await startVideoRecording({
      camera,
      withAudio: false,
      micDeviceId: null,
      onInterrupted,
      env: harness.env,
    });
    harness.camTrack.fire();
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    session.discard();
  });

  it("flags takes that are too short or too large", () => {
    expect(
      getRecordingProblem({ blob: new Blob(["x"]), duration: 900 }),
    ).toEqual({ key: "tooShort" });
    expect(
      getRecordingProblem({
        blob: new Blob([new Uint8Array(VIDEO_MAX_BYTES + 1)]),
        duration: 5_000,
      }),
    ).toEqual({ key: "tooLarge", size: "12.0" });
    expect(
      getRecordingProblem({ blob: new Blob(["x"]), duration: 1_000 }),
    ).toBeNull();
  });

  it("fits frames into a long side without upscaling", () => {
    expect(fitWithin(1280, 720, 320)).toEqual({ width: 320, height: 180 });
    expect(fitWithin(720, 1280, 320)).toEqual({ width: 180, height: 320 });
    expect(fitWithin(200, 100, 320)).toEqual({ width: 200, height: 100 });
  });

  it("lists only devices with an id", async () => {
    const { env } = createEnv();
    expect(
      (await listMediaDevices("videoinput", env)).map((d) => d.deviceId),
    ).toEqual(["cam-1"]);
    expect(
      (await listMediaDevices("audioinput", env)).map((d) => d.deviceId),
    ).toEqual(["mic-1"]);
  });
});
