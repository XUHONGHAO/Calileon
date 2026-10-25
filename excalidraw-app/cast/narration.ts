import {
  AUDIO_MIME_TYPES,
  AUDIO_RECORDING_MIN_DURATION,
} from "@excalidraw/common";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";
import { acquireMicLock } from "@excalidraw/excalidraw/voice/micLock";
import {
  VoiceRecorderFailure,
  startVoiceRecorder,
} from "@excalidraw/excalidraw/voice/recorder";

import type {
  VoiceRecorder,
  VoiceRecorderError,
} from "@excalidraw/excalidraw/voice/recorder";

import type { CastNarrationV1 } from "./types";

// Cast narration (ADR 0034 R5): the microphone is recorded next to the
// semantic script and replayed in sync with it.

/** user decision: 30 minutes (~7 MB at 32 kbps); the drawing keeps going */
export const CAST_NARRATION_MAX_DURATION = 30 * 60 * 1000;

export const CAST_NARRATION_PREF_KEY = "calileon-cast-narration";

export const isNarrationPreferred = () => {
  try {
    return localStorage.getItem(CAST_NARRATION_PREF_KEY) === "1";
  } catch {
    return false;
  }
};

export const setNarrationPreferred = (value: boolean) => {
  try {
    localStorage.setItem(CAST_NARRATION_PREF_KEY, value ? "1" : "0");
  } catch {}
};

export const isNarrationMimeType = (mimeType: unknown): mimeType is string =>
  typeof mimeType === "string" &&
  (Object.values(AUDIO_MIME_TYPES) as string[]).includes(mimeType);

export type NarrationFailure = VoiceRecorderError | "micBusy";

export type CastNarrationSession = {
  pause(): void;
  resume(): void;
  /** stops the mic; resolves null when nothing usable was recorded */
  finish(): Promise<CastNarrationV1 | null>;
  discard(): void;
};

/**
 * Starts recording the microphone for a Cast that is already running.
 * Returns null when the mic is held elsewhere (voice tool, dictation,
 * Synesthesia): the Cast then records without sound, it never preempts.
 */
export const startCastNarration = (opts: {
  /** Cast elapsed time, paused time excluded */
  getScriptTime: () => number;
  deviceId: string | null;
  /** the mic could not be opened; the drawing keeps recording */
  onFailure: (reason: NarrationFailure) => void;
  /** the time limit was hit or the device went away */
  onEnded: (reason: "limit" | "interrupted") => void;
  start?: typeof startVoiceRecorder;
}): CastNarrationSession | null => {
  const releaseLock = acquireMicLock("cast-narration");
  if (!releaseLock) {
    return null;
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
  };

  let recorder: VoiceRecorder | null = null;
  let offsetMs = 0;
  let paused = false;
  let discarded = false;
  let result: Promise<CastNarrationV1 | null> | null = null;

  const pending = (opts.start ?? startVoiceRecorder)({
    deviceId: opts.deviceId,
    maxDuration: CAST_NARRATION_MAX_DURATION,
    onAutoStop: () => opts.onEnded("limit"),
    onInterrupted: () => opts.onEnded("interrupted"),
  }).then(
    (next) => {
      if (discarded || result) {
        next.discard();
        return null;
      }
      recorder = next;
      // the permission prompt may have taken a while
      offsetMs = Math.max(0, Math.round(opts.getScriptTime()));
      if (paused) {
        next.pause();
      }
      return next;
    },
    (error) => {
      release();
      if (!discarded) {
        opts.onFailure(
          error instanceof VoiceRecorderFailure ? error.reason : "audioError",
        );
      }
      return null;
    },
  );

  const finish = async (): Promise<CastNarrationV1 | null> => {
    const current = await pending;
    if (!current || discarded) {
      release();
      return null;
    }
    try {
      const recording = await current.stop();
      if (recording.duration < AUDIO_RECORDING_MIN_DURATION) {
        return null;
      }
      return {
        mimeType: recording.mimeType,
        dataURL: await getDataURL(recording.blob),
        offsetMs,
        durationMs: recording.duration,
      };
    } catch (error) {
      console.error(error);
      return null;
    } finally {
      release();
    }
  };

  return {
    pause: () => {
      paused = true;
      recorder?.pause();
    },
    resume: () => {
      paused = false;
      recorder?.resume();
    },
    // idempotent: the time limit may finish it before the Cast stops
    finish: () => (result ??= finish()),
    discard: () => {
      if (discarded) {
        return;
      }
      discarded = true;
      recorder?.discard();
      recorder = null;
      release();
    },
  };
};

/** Turns a narration's dataURL into a playable object URL. */
export const createNarrationURL = (narration: CastNarrationV1) => {
  const [, base64 = ""] = narration.dataURL.split(",", 2);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: narration.mimeType }));
};

/** drift the playback clock may build up before the audio is re-seeked */
const NARRATION_DRIFT_TOLERANCE = 0.3;

export type NarrationMedia = Pick<
  HTMLMediaElement,
  "currentTime" | "paused" | "playbackRate" | "pause" | "play"
>;

/**
 * Keeps the narration in step with the replay. The replay clock stays the
 * master (it also runs where there's no audio); the audio follows, and is
 * only re-seeked when it drifts, so normal playback doesn't stutter.
 */
export const syncNarration = (
  media: NarrationMedia,
  narration: Pick<CastNarrationV1, "offsetMs" | "durationMs">,
  state: { timeMs: number; playing: boolean; speed: number },
) => {
  const audioTime = (state.timeMs - narration.offsetMs) / 1000;
  const inRange = audioTime >= 0 && audioTime < narration.durationMs / 1000;
  if (!state.playing || !inRange) {
    if (!media.paused) {
      media.pause();
    }
    if (!state.playing && inRange) {
      // a paused scrub lands the audio where playback will resume
      media.currentTime = audioTime;
    }
    return;
  }
  if (media.playbackRate !== state.speed) {
    media.playbackRate = state.speed;
  }
  if (
    media.paused ||
    Math.abs(media.currentTime - audioTime) > NARRATION_DRIFT_TOLERANCE
  ) {
    media.currentTime = audioTime;
  }
  if (media.paused) {
    void media.play().catch(() => {});
  }
};
