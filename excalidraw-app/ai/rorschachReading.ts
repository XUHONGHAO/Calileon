import type { RorschachReading } from "./rorschachTypes";

/**
 * Parses the vision agent answer for the Rorschach flow.
 *
 * The provider is asked for a single JSON object; models routinely wrap it in
 * a markdown fence or add surrounding whitespace, so exactly one complete fence
 * is tolerated. Anything else (prose around the object, wrong types, missing
 * fields, over-long text) is a hard failure so the caller can offer an explicit
 * retry instead of silently drawing from a mangled reading.
 */

export const RORSCHACH_READING_MAX_CHARS = 40;
export const RORSCHACH_READING_MAX_WORDS = 20;
export const RORSCHACH_IMAGE_PROMPT_MAX_CHARS = 2000;

export class RorschachParseError extends Error {
  code:
    | "not-json"
    | "not-object"
    | "missing-reading"
    | "missing-image-prompt"
    | "reading-too-long"
    | "image-prompt-too-long";

  constructor(code: RorschachParseError["code"]) {
    super(`Rorschach response failed validation: ${code}`);
    this.name = "RorschachParseError";
    this.code = code;
  }
}

const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;

const stripSingleFence = (value: string) => {
  const match = value.match(FENCE_PATTERN);
  return match ? match[1].trim() : value;
};

/** Grapheme-agnostic count of Unicode code points. */
export const countCodePoints = (value: string) => Array.from(value).length;

export const countWords = (value: string) =>
  value.trim().split(/\s+/).filter(Boolean).length;

export const isEnglishLocale = (locale: string) =>
  !/^\s*zh|^\s*ja|^\s*ko/i.test(locale || "");

export const assertReadingLength = (reading: string, locale: string) => {
  if (isEnglishLocale(locale)) {
    if (countWords(reading) > RORSCHACH_READING_MAX_WORDS) {
      throw new RorschachParseError("reading-too-long");
    }
    return;
  }
  if (countCodePoints(reading) > RORSCHACH_READING_MAX_CHARS) {
    throw new RorschachParseError("reading-too-long");
  }
};

const readField = (
  value: unknown,
  code: "missing-reading" | "missing-image-prompt",
) => {
  if (typeof value !== "string") {
    throw new RorschachParseError(code);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RorschachParseError(code);
  }
  return trimmed;
};

export const parseRorschachReading = (
  rawText: string,
  locale: string,
): RorschachReading => {
  if (typeof rawText !== "string") {
    throw new RorschachParseError("not-json");
  }

  const candidate = stripSingleFence(rawText.trim());
  if (!candidate) {
    throw new RorschachParseError("not-json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new RorschachParseError("not-json");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RorschachParseError("not-object");
  }

  const record = parsed as Record<string, unknown>;
  const reading = readField(record.reading, "missing-reading");
  const imagePrompt = readField(record.imagePrompt, "missing-image-prompt");

  assertReadingLength(reading, locale);

  if (imagePrompt.length > RORSCHACH_IMAGE_PROMPT_MAX_CHARS) {
    throw new RorschachParseError("image-prompt-too-long");
  }

  return { reading, imagePrompt };
};
