import {
  AUDIO_MIME_TYPES,
  AUDIO_PEAKS_COUNT,
  AUDIO_RECORDING_MAX_DURATION,
} from "@excalidraw/common";

import type { ValueOf } from "@excalidraw/common/utility-types";

/** why a recording could not start or ended abnormally (ADR 0034 §4) */
export type VoiceRecorderError =
  | "unsupported"
  | "blocked"
  | "permission"
  | "noDevice"
  | "busy"
  | "audioError";

export class VoiceRecorderFailure extends Error {
  constructor(public readonly reason: VoiceRecorderError) {
    super(reason);
    this.name = "VoiceRecorderFailure";
  }
}

export type VoiceRecording = {
  blob: Blob;
  mimeType: ValueOf<typeof AUDIO_MIME_TYPES>;
  /** milliseconds, capped at the recorder's `maxDuration` */
  duration: number;
  /** AUDIO_PEAKS_COUNT values in 0..1 */
  peaks: number[];
};

export type VoiceRecorder = {
  /** the recorded track; shared with speech recognition (path B) in M3 */
  readonly track: MediaStreamTrack;
  /** the device actually opened (may differ from the requested one) */
  readonly deviceId: string | null;
  /** recorded milliseconds, paused time excluded */
  elapsed(): number;
  /** pauses capture; the time limit is paused with it (Cast narration) */
  pause(): void;
  resume(): void;
  /** current input level in 0..1 for the live waveform */
  level(): number;
  /** stops and resolves the recording */
  stop(): Promise<VoiceRecording>;
  /** stops and throws the audio away */
  discard(): void;
};

type RecorderEnvironment = {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder?: typeof MediaRecorder;
  AudioContext?: typeof AudioContext;
  isSecureContext?: boolean;
  /** Permissions-Policy check; `false` when `microphone` is not allowed */
  isMicrophoneAllowedByPolicy?: () => boolean;
  now?: () => number;
};

const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

/** ~240 KB per minute: far below FILE_UPLOAD_MAX_BYTES, fine for speech */
const RECORDING_BITS_PER_SECOND = 32_000;
const LEVEL_SAMPLE_INTERVAL = 50;

const getBaseMimeType = (
  mimeType: string,
): ValueOf<typeof AUDIO_MIME_TYPES> => {
  const base = mimeType.split(";")[0].trim();
  const known = Object.values(AUDIO_MIME_TYPES) as string[];
  return (known.includes(base) ? base : AUDIO_MIME_TYPES.webm) as ValueOf<
    typeof AUDIO_MIME_TYPES
  >;
};

export const pickRecordingMimeType = (
  isTypeSupported: (mimeType: string) => boolean,
) => RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? "";

/**
 * Turns the RMS levels sampled while recording into display peaks. Levels are
 * scaled against the loudest sample (with a floor so silence stays flat) and
 * square-rooted so quiet speech still reads as a waveform.
 */
export const levelsToPeaks = (levels: readonly number[]): number[] => {
  if (!levels.length) {
    return new Array(AUDIO_PEAKS_COUNT).fill(0);
  }
  const max = Math.max(0.05, ...levels);
  const peaks: number[] = [];
  for (let i = 0; i < AUDIO_PEAKS_COUNT; i++) {
    const start = Math.floor((i * levels.length) / AUDIO_PEAKS_COUNT);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * levels.length) / AUDIO_PEAKS_COUNT),
    );
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j++) {
      peak = Math.max(peak, levels[j]);
    }
    peaks.push(Math.round(Math.sqrt(Math.min(1, peak / max)) * 100) / 100);
  }
  return peaks;
};

const toFailure = (error: unknown): VoiceRecorderFailure => {
  if (error instanceof VoiceRecorderFailure) {
    return error;
  }
  const name = (error as { name?: string } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new VoiceRecorderFailure("permission");
    case "NotFoundError":
    case "OverconstrainedError":
      return new VoiceRecorderFailure("noDevice");
    case "NotReadableError":
    case "AbortError":
      return new VoiceRecorderFailure("busy");
    default:
      return new VoiceRecorderFailure("audioError");
  }
};

const defaultPolicyCheck = () => {
  const policy =
    (document as any).permissionsPolicy ?? (document as any).featurePolicy;
  if (typeof policy?.allowsFeature === "function") {
    return !!policy.allowsFeature("microphone");
  }
  return true;
};

const getDefaultEnvironment = (): RecorderEnvironment => ({
  mediaDevices:
    typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
  MediaRecorder:
    typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined,
  AudioContext: typeof AudioContext !== "undefined" ? AudioContext : undefined,
  isSecureContext:
    typeof window !== "undefined" ? window.isSecureContext : false,
  isMicrophoneAllowedByPolicy: defaultPolicyCheck,
  now: () => performance.now(),
});

const openStream = async (
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  deviceId: string | null,
) => {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
  };
  if (deviceId) {
    try {
      return await mediaDevices.getUserMedia({
        audio: { ...audio, deviceId: { exact: deviceId } },
      });
    } catch (error: any) {
      // the remembered device was unplugged: fall back to the default one
      if (
        error?.name !== "OverconstrainedError" &&
        error?.name !== "NotFoundError"
      ) {
        throw error;
      }
    }
  }
  return mediaDevices.getUserMedia({ audio });
};

/**
 * Opens the microphone and starts recording. `onAutoStop` fires when the
 * recording reaches `maxDuration` (default AUDIO_RECORDING_MAX_DURATION) so
 * the caller can save. Throws `VoiceRecorderFailure`.
 */
export const startVoiceRecorder = async (opts: {
  deviceId: string | null;
  /** milliseconds; Cast narration records longer than a voice message */
  maxDuration?: number;
  signal?: AbortSignal;
  onAutoStop?: () => void;
  /** the track ended on its own (device unplugged, permission revoked) */
  onInterrupted?: () => void;
  env?: RecorderEnvironment;
}): Promise<VoiceRecorder> => {
  const env = opts.env ?? getDefaultEnvironment();
  const now = env.now ?? (() => performance.now());
  const maxDuration = opts.maxDuration ?? AUDIO_RECORDING_MAX_DURATION;
  if (
    !env.isSecureContext ||
    !env.mediaDevices?.getUserMedia ||
    !env.MediaRecorder ||
    !env.AudioContext
  ) {
    throw new VoiceRecorderFailure("unsupported");
  }
  if (env.isMicrophoneAllowedByPolicy && !env.isMicrophoneAllowedByPolicy()) {
    throw new VoiceRecorderFailure("blocked");
  }

  let stream: MediaStream;
  try {
    stream = await openStream(env.mediaDevices, opts.deviceId);
  } catch (error) {
    throw toFailure(error);
  }
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  if (opts.signal?.aborted) {
    stopTracks();
    throw new DOMException("", "AbortError");
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopTracks();
    throw new VoiceRecorderFailure("noDevice");
  }

  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  let recorder: MediaRecorder;
  try {
    context = new env.AudioContext();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const mimeType = pickRecordingMimeType((type) =>
      env.MediaRecorder!.isTypeSupported(type),
    );
    recorder = new env.MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
    });
  } catch (error) {
    stopTracks();
    throw toFailure(error);
  }

  const chunks: Blob[] = [];
  const levels: number[] = [];
  const samples = new Float32Array(analyser.fftSize);
  let currentLevel = 0;
  let finished = false;
  let startedAt = now();
  let stoppedAt: number | null = null;
  let pausedAt: number | null = null;
  let pausedTotal = 0;

  const sampleLevel = () => {
    if (pausedAt !== null) {
      return;
    }
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    levels.push(rms);
    currentLevel = Math.min(1, rms * 5);
  };

  const elapsed = () =>
    Math.max(
      0,
      Math.min(
        maxDuration,
        (pausedAt ?? stoppedAt ?? now()) - startedAt - pausedTotal,
      ),
    );

  const levelTimer = setInterval(sampleLevel, LEVEL_SAMPLE_INTERVAL);
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLimit = () => {
    clearTimeout(limitTimer);
    limitTimer = setTimeout(() => {
      if (!finished) {
        opts.onAutoStop?.();
      }
    }, Math.max(0, maxDuration - elapsed()));
  };
  scheduleLimit();

  const cleanup = () => {
    finished = true;
    clearInterval(levelTimer);
    clearTimeout(limitTimer);
    track.onended = null;
    stopTracks();
    source.disconnect();
    void context.close().catch(() => {});
  };

  track.onended = () => {
    if (!finished) {
      opts.onInterrupted?.();
    }
  };
  recorder.ondataavailable = (event) => {
    if (event.data?.size) {
      chunks.push(event.data);
    }
  };
  recorder.onstart = () => {
    startedAt = now();
  };
  try {
    recorder.start(1000);
  } catch (error) {
    cleanup();
    throw toFailure(error);
  }

  return {
    track,
    deviceId: track.getSettings?.().deviceId ?? opts.deviceId,
    elapsed,
    level: () => (pausedAt === null ? currentLevel : 0),
    pause: () => {
      if (finished || pausedAt !== null || recorder.state !== "recording") {
        return;
      }
      recorder.pause();
      pausedAt = now();
      clearTimeout(limitTimer);
    },
    resume: () => {
      if (finished || pausedAt === null) {
        return;
      }
      recorder.resume();
      pausedTotal += now() - pausedAt;
      pausedAt = null;
      scheduleLimit();
    },
    stop: () =>
      new Promise<VoiceRecording>((resolve, reject) => {
        if (finished) {
          reject(new VoiceRecorderFailure("audioError"));
          return;
        }
        if (pausedAt !== null) {
          pausedTotal += now() - pausedAt;
          pausedAt = null;
        }
        stoppedAt = now();
        const duration = elapsed();
        recorder.onerror = () => {
          cleanup();
          reject(new VoiceRecorderFailure("audioError"));
        };
        recorder.onstop = () => {
          cleanup();
          const mimeType = getBaseMimeType(recorder.mimeType || "");
          resolve({
            blob: new Blob(chunks, { type: mimeType }),
            mimeType,
            duration: Math.round(duration),
            peaks: levelsToPeaks(levels),
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

export type OpenMicrophone = {
  readonly track: MediaStreamTrack;
  /** current input level in 0..1 */
  level(): number;
  close(): void;
};

/**
 * Opens the microphone without recording, for text-box dictation (ADR 0034
 * §8). Same device choice and failure reasons as `startVoiceRecorder`.
 */
export const openMicrophone = async (opts: {
  deviceId: string | null;
  onEnded?: () => void;
  env?: RecorderEnvironment;
}): Promise<OpenMicrophone> => {
  const env = opts.env ?? getDefaultEnvironment();
  if (!env.isSecureContext || !env.mediaDevices?.getUserMedia) {
    throw new VoiceRecorderFailure("unsupported");
  }
  if (env.isMicrophoneAllowedByPolicy && !env.isMicrophoneAllowedByPolicy()) {
    throw new VoiceRecorderFailure("blocked");
  }
  let stream: MediaStream;
  try {
    stream = await openStream(env.mediaDevices, opts.deviceId);
  } catch (error) {
    throw toFailure(error);
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((each) => each.stop());
    throw new VoiceRecorderFailure("noDevice");
  }
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    if (env.AudioContext) {
      context = new env.AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
    }
  } catch {
    // the level only drives the fallback heuristic; dictation works without
    analyser = null;
  }
  const samples = analyser ? new Float32Array(analyser.fftSize) : null;
  let closed = false;
  track.onended = () => {
    if (!closed) {
      opts.onEnded?.();
    }
  };
  return {
    track,
    level: () => {
      if (!analyser || !samples) {
        return 0;
      }
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      return Math.min(1, Math.sqrt(sum / samples.length) * 5);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      track.onended = null;
      stream.getTracks().forEach((each) => each.stop());
      void context?.close().catch(() => {});
    },
  };
};

export const listMicrophones = async (): Promise<MediaDeviceInfo[]> => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (device) => device.kind === "audioinput" && device.deviceId,
    );
  } catch {
    return [];
  }
};
