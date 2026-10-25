import {
  AUDIO_AVATAR_COLORS,
  AUDIO_ELEMENT_HEIGHT,
  AUDIO_ELEMENT_MAX_WIDTH,
  AUDIO_ELEMENT_MIN_WIDTH,
  AUDIO_PEAKS_COUNT,
  AUDIO_RECORDING_MAX_DURATION,
} from "@excalidraw/common";
import { clamp } from "@excalidraw/math";

import type {
  AudioAuthor,
  AudioAvatar,
  AudioTranscript,
  ExcalidrawAudioElement,
} from "../types";

const MIN_DURATION = 1000;

/**
 * Bubble width grows linearly with duration like a chat voice message.
 * Only used when an element is created; restore clamps instead (ADR 0034).
 */
export const getAudioElementWidth = (duration: number) => {
  const ratio = clamp(
    (duration - MIN_DURATION) / (AUDIO_RECORDING_MAX_DURATION - MIN_DURATION),
    0,
    1,
  );
  return Math.round(
    AUDIO_ELEMENT_MIN_WIDTH +
      (AUDIO_ELEMENT_MAX_WIDTH - AUDIO_ELEMENT_MIN_WIDTH) * ratio,
  );
};

export const clampAudioElementWidth = (width: unknown) =>
  typeof width === "number" && Number.isFinite(width)
    ? clamp(width, AUDIO_ELEMENT_MIN_WIDTH, AUDIO_ELEMENT_MAX_WIDTH)
    : AUDIO_ELEMENT_MIN_WIDTH;

/** `12″` below a minute, `1′05″` above, matching chat apps. */
export const formatAudioDuration = (duration: number) => {
  const seconds = Math.max(1, Math.round(duration / 1000));
  if (seconds < 60) {
    return `${seconds}″`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}′${String(seconds % 60).padStart(2, "0")}″`;
};

const roundPeak = (value: number) => Math.round(clamp(value, 0, 1) * 100) / 100;

/**
 * Downsamples (max per bucket) or repeats samples to exactly
 * AUDIO_PEAKS_COUNT values in 0..1 with two decimals. Deterministic, so every
 * client restores the same peaks.
 */
export const normalizeAudioPeaks = (input: unknown): number[] => {
  const samples = Array.isArray(input)
    ? input.map((value) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0,
      )
    : [];
  if (!samples.length) {
    return new Array(AUDIO_PEAKS_COUNT).fill(0);
  }
  const peaks: number[] = [];
  for (let i = 0; i < AUDIO_PEAKS_COUNT; i++) {
    const start = Math.floor((i * samples.length) / AUDIO_PEAKS_COUNT);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * samples.length) / AUDIO_PEAKS_COUNT),
    );
    let peak = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      peak = Math.max(peak, Math.abs(samples[j]));
    }
    peaks.push(roundPeak(peak));
  }
  return peaks;
};

const AVATAR_GLYPH_RE = /^(?:\p{Unified_Ideograph}|[A-Z])$/u;

export const isValidAudioAvatarGlyph = (glyph: unknown): glyph is string =>
  typeof glyph === "string" && AVATAR_GLYPH_RE.test(glyph);

export const isValidAudioAvatarColor = (color: unknown): color is string =>
  typeof color === "string" &&
  (AUDIO_AVATAR_COLORS as readonly string[]).includes(color);

export const restoreAudioAvatar = (avatar: unknown): AudioAvatar | null => {
  if (!avatar || typeof avatar !== "object") {
    return null;
  }
  const { color, glyph } = avatar as Record<string, unknown>;
  return isValidAudioAvatarColor(color) && isValidAudioAvatarGlyph(glyph)
    ? { color, glyph }
    : null;
};

/** Fallback avatar derived from the display name (or a placeholder). */
export const getDefaultAudioAvatar = (name: string | null): AudioAvatar => {
  const first = name ? Array.from(name.trim())[0] ?? "" : "";
  const upper = first.toUpperCase();
  const glyph = isValidAudioAvatarGlyph(upper) ? upper : "?";
  let hash = 0;
  for (const char of name ?? "") {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return {
    color: AUDIO_AVATAR_COLORS[hash % AUDIO_AVATAR_COLORS.length],
    glyph,
  };
};

export const getAudioAvatar = (
  author: ExcalidrawAudioElement["author"],
): AudioAvatar => author?.avatar ?? getDefaultAudioAvatar(author?.name ?? null);

const MAX_NAME_LENGTH = 100;
const MAX_TRANSCRIPT_LENGTH = 10_000;

const restoreAuthor = (author: unknown): AudioAuthor | null => {
  if (!author || typeof author !== "object") {
    return null;
  }
  const { name, avatar } = author as Record<string, unknown>;
  if (typeof name !== "string") {
    return null;
  }
  return {
    name: name.slice(0, MAX_NAME_LENGTH),
    avatar: restoreAudioAvatar(avatar),
  };
};

const restoreTranscript = (transcript: unknown): AudioTranscript | null => {
  if (!transcript || typeof transcript !== "object") {
    return null;
  }
  const { text, lang, mode } = transcript as Record<string, unknown>;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    typeof lang !== "string" ||
    (mode !== "auto" && mode !== "local-only")
  ) {
    return null;
  }
  return { text: text.slice(0, MAX_TRANSCRIPT_LENGTH), lang, mode };
};

export type RestoredAudioFields = Pick<
  ExcalidrawAudioElement,
  | "source"
  | "duration"
  | "peaks"
  | "transcript"
  | "author"
  | "hostId"
  | "width"
  | "height"
  | "angle"
>;

/**
 * Validates untrusted audio fields. Returns null for an unknown `source` so
 * the element is dropped rather than silently rewritten (ADR 0034 §1).
 */
export const restoreAudioFields = (
  element: Record<string, unknown>,
): RestoredAudioFields | null => {
  const { source, duration } = element;
  if (source !== "recording" && source !== "generated") {
    return null;
  }
  const safeDuration =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? source === "recording"
        ? Math.min(duration, AUDIO_RECORDING_MAX_DURATION)
        : duration
      : MIN_DURATION;
  return {
    source,
    duration: Math.round(safeDuration),
    peaks: normalizeAudioPeaks(element.peaks),
    transcript: restoreTranscript(element.transcript),
    author: restoreAuthor(element.author),
    hostId:
      typeof element.hostId === "string" && element.hostId
        ? element.hostId
        : null,
    width: clampAudioElementWidth(element.width),
    height: AUDIO_ELEMENT_HEIGHT,
    angle: 0 as ExcalidrawAudioElement["angle"],
  };
};
