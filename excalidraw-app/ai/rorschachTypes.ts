import type { TranslationKeys } from "@excalidraw/excalidraw/i18n";

export type RorschachTranslationKey = TranslationKeys;

/**
 * G6 Rorschach Mirror — domain types.
 *
 * Everything here is session-scoped: nothing is persisted to IndexedDB,
 * localStorage or the scene except the sanitized relationship recorded on the
 * inserted elements by `rorschachCanvas.ts`.
 */

export type RorschachPersonaId =
  | "gentleCounselor"
  | "mysticMaster"
  | "grimDiviner";

export type RorschachPersona = {
  id: RorschachPersonaId;
  /** Locale keys under `labs.rorschach.personas.*`. */
  nameKey: RorschachTranslationKey;
  promptKey: RorschachTranslationKey;
  /** Persona voice instructions appended to the safety preamble. */
  voice: string;
  /** Short English style hint appended to the image prompt. */
  imageStyle: string;
};

/** Main button reads then draws; secondary button only reads. */
export type RorschachRunMode = "read-and-draw" | "read-only";

export type RorschachStageStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RorschachReading = {
  /** Localized "I see ..." sentence shown to the user. */
  reading: string;
  /** English image prompt derived from the reading. */
  imagePrompt: string;
};

export type RorschachAttempt = {
  id: string;
  /** Increments per attempt; late async work compares against it. */
  sequence: number;
  mode: RorschachRunMode;
  personaId: RorschachPersonaId;
  readingStatus: RorschachStageStatus;
  imageStatus: RorschachStageStatus;
  result: RorschachReading | null;
  /** The exact selection snapshot this attempt reads; reused by every retry. */
  image: string;
  imageOutput: RorschachImageOutput | null;
  readingError: string | null;
  imageError: string | null;
  createdAt: number;
};

export type RorschachImageOutput = {
  dataURL: string;
  mimeType: string;
  storageType?: "data-url" | "remote-url";
  revisedPrompt?: string;
};

export type RorschachInputSnapshot = {
  dataURL: string;
  width: number;
  height: number;
  sourceElementIds: string[];
  /** Bounds of the source selection at capture time. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Locale the reading was requested in. */
  locale: string;
};

export type RorschachSession = {
  batchId: string;
  input: RorschachInputSnapshot | null;
  personaId: RorschachPersonaId;
  runMode: RorschachRunMode;
  attempts: RorschachAttempt[];
  activeAttemptId: string | null;
  /** Successful readings of this session, latest last, capped. */
  history: string[];
};

export type RorschachPortableRelation = {
  persona: string;
  reading: string;
  sourceElementIds: string[];
  batchId: string;
};
