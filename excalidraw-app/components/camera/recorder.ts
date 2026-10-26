import {
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
  VIDEO_POSTER_MAX_LENGTH,
  VIDEO_POSTER_MAX_SIZE,
  VIDEO_RECORDING_MAX_DURATION,
  VIDEO_RECORDING_MIN_DURATION,
} from "@excalidraw/common";
import { acquireMicLock } from "@excalidraw/excalidraw/voice/micLock";

import type { ValueOf } from "@excalidraw/common/utility-types";

// Camera capture (ADR 0035 §5): one preview stream, photos taken from it and
// recordings made on top of it. The mic is only opened (and locked) while a
// recording with sound is running, never for the preview.

/** why the camera or a recording could not start (ADR 0035 §5) */
export type CameraError =
  | "unsupported"
  | "blocked"
  | "permission"
  | "noDevice"
  | "busy"
  | "micBusy"
  | "micUnavailable"
  | "recorderUnsupported"
  | "cameraError";

export class CameraFailure extends Error {
  constructor(public readonly reason: CameraError) {
    super(reason);
    this.name = "CameraFailure";
  }
}

export type CameraEnvironment = {
  mediaDevices?: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">;
  MediaRecorder?: typeof MediaRecorder;
  MediaStream?: typeof MediaStream;
  isSecureContext?: boolean;
  /** Permissions-Policy check; `false` when the feature is not allowed */
  isAllowedByPolicy?: (feature: "camera" | "microphone") => boolean;
  acquireMicLock?: (owner: string) => (() => void) | null;
  now?: () => number;
};

export const CAMERA_MIC_LOCK_OWNER = "camera-video";

const RECORDING_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/** 30 s at ~2 Mbps stays around 7.5 MB, under VIDEO_MAX_BYTES */
const VIDEO_BITS_PER_SECOND = 2_000_000;
const AUDIO_BITS_PER_SECOND = 64_000;

const PHOTO_MAX_SIZE = 2048;
const PHOTO_QUALITY = 0.92;

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

const defaultPolicyCheck = (feature: "camera" | "microphone") => {
  const policy =
    (document as any).permissionsPolicy ?? (document as any).featurePolicy;
  if (typeof policy?.allowsFeature === "function") {
    return !!policy.allowsFeature(feature);
  }
  return true;
};

const getDefaultEnvironment = (): CameraEnvironment => ({
  mediaDevices:
    typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
  MediaRecorder:
    typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined,
  MediaStream: typeof MediaStream !== "undefined" ? MediaStream : undefined,
  isSecureContext:
    typeof window !== "undefined" ? window.isSecureContext : false,
  isAllowedByPolicy: defaultPolicyCheck,
  acquireMicLock,
  now: () => performance.now(),
});

export const pickVideoMimeType = (
  isTypeSupported: (mimeType: string) => boolean,
) => RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? "";

/** `video/mp4;codecs=...` → `video/mp4`; null for anything we don't store */
export const getBaseVideoMimeType = (
  mimeType: string,
): ValueOf<typeof VIDEO_MIME_TYPES> | null => {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  const known = Object.values(VIDEO_MIME_TYPES) as string[];
  return known.includes(base)
    ? (base as ValueOf<typeof VIDEO_MIME_TYPES>)
    : null;
};

const toCameraFailure = (error: unknown): CameraFailure => {
  if (error instanceof CameraFailure) {
    return error;
  }
  switch ((error as { name?: string } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return new CameraFailure("permission");
    case "NotFoundError":
    case "OverconstrainedError":
      return new CameraFailure("noDevice");
    case "NotReadableError":
    case "AbortError":
      return new CameraFailure("busy");
    default:
      return new CameraFailure("cameraError");
  }
};

const isMissingDeviceError = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
};

/** opens the remembered device, falling back to the default one if it's gone */
const getUserMediaWithFallback = async (
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  kind: "video" | "audio",
  base: MediaTrackConstraints,
  deviceId: string | null,
) => {
  if (deviceId) {
    try {
      return await mediaDevices.getUserMedia({
        [kind]: { ...base, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      if (!isMissingDeviceError(error)) {
        throw error;
      }
    }
  }
  return mediaDevices.getUserMedia({ [kind]: base });
};

export type OpenCamera = {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  /** the device actually opened (may differ from the requested one) */
  readonly deviceId: string | null;
  /** `environment` for rear phone cameras: their preview isn't mirrored */
  readonly facingMode: string | null;
  close(): void;
};

/** Opens the camera for the preview. Throws `CameraFailure`. */
export const openCamera = async (opts: {
  deviceId: string | null;
  /** the track ended on its own (device unplugged, permission revoked) */
  onEnded?: () => void;
  env?: CameraEnvironment;
}): Promise<OpenCamera> => {
  const env = opts.env ?? getDefaultEnvironment();
  if (!env.isSecureContext || !env.mediaDevices?.getUserMedia) {
    throw new CameraFailure("unsupported");
  }
  if (env.isAllowedByPolicy && !env.isAllowedByPolicy("camera")) {
    throw new CameraFailure("blocked");
  }
  let stream: MediaStream;
  try {
    stream = await getUserMediaWithFallback(
      env.mediaDevices,
      "video",
      VIDEO_CONSTRAINTS,
      opts.deviceId,
    );
  } catch (error) {
    throw toCameraFailure(error);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((each) => each.stop());
    throw new CameraFailure("noDevice");
  }
  const settings = track.getSettings?.() ?? {};
  let closed = false;
  track.onended = () => {
    if (!closed) {
      opts.onEnded?.();
    }
  };
  return {
    stream,
    track,
    deviceId: settings.deviceId ?? opts.deviceId,
    facingMode: settings.facingMode ?? null,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      track.onended = null;
      stream.getTracks().forEach((each) => each.stop());
    },
  };
};
export type VideoRecording = {
  blob: Blob;
  mimeType: ValueOf<typeof VIDEO_MIME_TYPES>;
  /** milliseconds, capped at the recorder's `maxDuration` */
  duration: number;
  hasAudio: boolean;
};

export type VideoRecorderSession = {
  /** recorded milliseconds */
  elapsed(): number;
  /** recorded bytes so far */
  size(): number;
  /** stops and resolves the recording; the camera preview stays open */
  stop(): Promise<VideoRecording>;
  /** stops and throws the recording away */
  discard(): void;
};

/**
 * Records the open camera, plus the microphone when `withAudio`. `onAutoStop`
 * fires at `maxDuration` (default 30 s) or when the take nears
 * VIDEO_MAX_BYTES, so the caller can stop and keep it. Throws `CameraFailure`.
 */
export const startVideoRecording = async (opts: {
  camera: OpenCamera;
  withAudio: boolean;
  micDeviceId: string | null;
  maxDuration?: number;
  onAutoStop?: () => void;
  /** a track ended on its own mid-recording */
  onInterrupted?: () => void;
  env?: CameraEnvironment;
}): Promise<VideoRecorderSession> => {
  const env = opts.env ?? getDefaultEnvironment();
  const now = env.now ?? (() => performance.now());
  const maxDuration = opts.maxDuration ?? VIDEO_RECORDING_MAX_DURATION;
  const Recorder = env.MediaRecorder;
  const Stream = env.MediaStream;
  if (!Recorder || !Stream) {
    throw new CameraFailure("recorderUnsupported");
  }
  const mimeType = pickVideoMimeType((type) => Recorder.isTypeSupported(type));
  if (!mimeType) {
    throw new CameraFailure("recorderUnsupported");
  }

  let releaseMic: (() => void) | null = null;
  let micStream: MediaStream | null = null;
  const releaseAudio = () => {
    micStream?.getTracks().forEach((each) => each.stop());
    micStream = null;
    releaseMic?.();
    releaseMic = null;
  };

  if (opts.withAudio) {
    if (
      !env.mediaDevices?.getUserMedia ||
      (env.isAllowedByPolicy && !env.isAllowedByPolicy("microphone"))
    ) {
      throw new CameraFailure("micUnavailable");
    }
    releaseMic = (env.acquireMicLock ?? acquireMicLock)(CAMERA_MIC_LOCK_OWNER);
    if (!releaseMic) {
      throw new CameraFailure("micBusy");
    }
    try {
      micStream = await getUserMediaWithFallback(
        env.mediaDevices,
        "audio",
        { echoCancellation: true, noiseSuppression: true },
        opts.micDeviceId,
      );
    } catch (error) {
      releaseAudio();
      const failure = toCameraFailure(error);
      throw new CameraFailure(
        failure.reason === "busy" ? "micBusy" : "micUnavailable",
      );
    }
  }

  const audioTrack = micStream?.getAudioTracks()[0] ?? null;
  const stream = new Stream(
    audioTrack ? [opts.camera.track, audioTrack] : [opts.camera.track],
  );

  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      ...(audioTrack ? { audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : {}),
    });
  } catch {
    releaseAudio();
    throw new CameraFailure("recorderUnsupported");
  }

  const chunks: Blob[] = [];
  let bytes = 0;
  let finished = false;
  let startedAt = now();
  let stoppedAt: number | null = null;

  const elapsed = () =>
    Math.max(0, Math.min(maxDuration, (stoppedAt ?? now()) - startedAt));

  const autoStop = () => {
    if (!finished) {
      opts.onAutoStop?.();
    }
  };
  let limitTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    autoStop,
    maxDuration,
  );

  const onTrackEnded = () => {
    if (!finished) {
      opts.onInterrupted?.();
    }
  };
  opts.camera.track.addEventListener("ended", onTrackEnded);
  audioTrack?.addEventListener("ended", onTrackEnded);

  const cleanup = () => {
    finished = true;
    clearTimeout(limitTimer);
    limitTimer = undefined;
    opts.camera.track.removeEventListener("ended", onTrackEnded);
    audioTrack?.removeEventListener("ended", onTrackEnded);
    releaseAudio();
  };

  recorder.ondataavailable = (event) => {
    if (event.data?.size) {
      chunks.push(event.data);
      bytes += event.data.size;
      // leave room for the last chunk and the container's tail
      if (bytes > VIDEO_MAX_BYTES * 0.9) {
        autoStop();
      }
    }
  };
  recorder.onstart = () => {
    startedAt = now();
  };
  try {
    recorder.start(1000);
  } catch {
    cleanup();
    throw new CameraFailure("recorderUnsupported");
  }

  return {
    elapsed,
    size: () => bytes,
    stop: () =>
      new Promise<VideoRecording>((resolve, reject) => {
        if (finished) {
          reject(new CameraFailure("cameraError"));
          return;
        }
        stoppedAt = now();
        const duration = Math.round(elapsed());
        recorder.onerror = () => {
          cleanup();
          reject(new CameraFailure("cameraError"));
        };
        recorder.onstop = () => {
          cleanup();
          const type =
            getBaseVideoMimeType(recorder.mimeType || "") ??
            getBaseVideoMimeType(mimeType);
          if (!type) {
            reject(new CameraFailure("recorderUnsupported"));
            return;
          }
          resolve({
            blob: new Blob(chunks, { type }),
            mimeType: type,
            duration,
            hasAudio: !!audioTrack,
          });
        };
        if (recorder.state === "inactive") {
          recorder.onstop(new Event("stop"));
        } else {
          recorder.stop();
        }
      }),
    discard: () => {
      if (finished) {
        return;
      }
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
      chunks.length = 0;
      cleanup();
    },
  };
};

export type RecordingProblem =
  | { key: "tooShort" }
  | { key: "tooLarge"; size: string };

/** a finished take that can't be kept (ADR 0035 §5) */
export const getRecordingProblem = (
  recording: Pick<VideoRecording, "blob" | "duration">,
): RecordingProblem | null => {
  if (recording.duration < VIDEO_RECORDING_MIN_DURATION) {
    return { key: "tooShort" };
  }
  if (recording.blob.size > VIDEO_MAX_BYTES) {
    return {
      key: "tooLarge",
      size: (recording.blob.size / 1024 / 1024).toFixed(1),
    };
  }
  return null;
};

/** fits `width × height` into a `max` long side, never upscaling */
export const fitWithin = (width: number, height: number, max: number) => {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const drawFrame = (video: HTMLVideoElement, max: number) => {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) {
    return null;
  }
  const size = fitWithin(videoWidth, videoHeight, max);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  // never mirrored: the saved frame is what others see (ADR 0035 §5)
  context.drawImage(video, 0, 0, size.width, size.height);
  return canvas;
};

/** an unmirrored JPEG of the current preview frame */
export const capturePhoto = (video: HTMLVideoElement): Promise<File | null> =>
  new Promise((resolve) => {
    const canvas = drawFrame(video, PHOTO_MAX_SIZE);
    if (!canvas) {
      resolve(null);
      return;
    }
    canvas.toBlob(
      (blob) =>
        resolve(
          blob
            ? new File([blob], `camera-photo-${Date.now()}.jpg`, {
                type: "image/jpeg",
              })
            : null,
        ),
      "image/jpeg",
      PHOTO_QUALITY,
    );
  });

/**
 * The cover drawn on the canvas: webp (or jpeg where webp encoding isn't
 * available), stepped down until it fits VIDEO_POSTER_MAX_LENGTH.
 */
export const capturePoster = (video: HTMLVideoElement): string | null => {
  const canvas = drawFrame(video, VIDEO_POSTER_MAX_SIZE);
  if (!canvas) {
    return null;
  }
  for (const [type, quality] of [
    ["image/webp", 0.7],
    ["image/webp", 0.5],
    ["image/jpeg", 0.6],
    ["image/jpeg", 0.4],
  ] as const) {
    let dataURL: string;
    try {
      dataURL = canvas.toDataURL(type, quality);
    } catch {
      return null;
    }
    if (
      dataURL.startsWith(`data:${type};base64,`) &&
      dataURL.length <= VIDEO_POSTER_MAX_LENGTH
    ) {
      return dataURL;
    }
  }
  return null;
};

/** the preview's real frame size; the track settings until it has decoded */
export const getVideoDimensions = (
  video: HTMLVideoElement | null,
  track: MediaStreamTrack | null,
) => {
  if (video?.videoWidth && video.videoHeight) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  const settings = track?.getSettings?.() ?? {};
  return {
    width: settings.width || 1280,
    height: settings.height || 720,
  };
};

export const listMediaDevices = async (
  kind: "videoinput" | "audioinput",
  env?: CameraEnvironment,
): Promise<MediaDeviceInfo[]> => {
  const mediaDevices = (env ?? getDefaultEnvironment()).mediaDevices;
  try {
    const devices = (await mediaDevices?.enumerateDevices()) ?? [];
    // labels and ids stay empty until a permission was granted
    return devices.filter((device) => device.kind === kind && device.deviceId);
  } catch {
    return [];
  }
};
