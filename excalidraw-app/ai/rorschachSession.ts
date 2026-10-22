import { t } from "@excalidraw/excalidraw/i18n";

import { describeImageWithVisionAgent } from "./visionAgentAdapter";

import type {
  RorschachAttempt,
  RorschachImageOutput,
  RorschachPersonaId,
  RorschachReading,
  RorschachRunMode,
  RorschachSession,
} from "./rorschachTypes";

export const createRorschachId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

export const createRorschachSession = (
  personaId: RorschachPersonaId,
): RorschachSession => ({
  batchId: createRorschachId("rorschach"),
  input: null,
  personaId,
  runMode: "read-and-draw",
  attempts: [],
  activeAttemptId: null,
  history: [],
});

export const createRorschachAttempt = ({
  sequence,
  mode,
  personaId,
  image,
}: {
  sequence: number;
  mode: RorschachRunMode;
  personaId: RorschachPersonaId;
  image: string;
}): RorschachAttempt => ({
  id: createRorschachId("rorschach-attempt"),
  sequence,
  mode,
  personaId,
  readingStatus: "idle",
  imageStatus: "idle",
  result: null,
  image,
  imageOutput: null,
  readingError: null,
  imageError: null,
  createdAt: Date.now(),
});

/** Applies a patch to the matching attempt, if it is still the current one. */
export const patchRorschachAttempt = (
  session: RorschachSession,
  attemptId: string,
  patch: Partial<RorschachAttempt>,
): RorschachSession => {
  if (!session.attempts.some((attempt) => attempt.id === attemptId)) {
    return session;
  }
  return {
    ...session,
    attempts: session.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, ...patch } : attempt,
    ),
  };
};

export type RorschachReadingDeps = {
  describe?: typeof describeImageWithVisionAgent;
};

export type RunRorschachReadingOptions = {
  session: RorschachSession;
  attempt: RorschachAttempt;
  agent: Parameters<typeof describeImageWithVisionAgent>[0]["agent"];
  systemPrompt: string;
  userPrompt: string;
  locale: string;
  signal: AbortSignal;
  parse: (text: string, locale: string) => RorschachReading;
  /** Returns true when the run is still current and allowed to write back. */
  isCurrent: () => boolean;
  onPatch: (attemptId: string, patch: Partial<RorschachAttempt>) => void;
  deps?: RorschachReadingDeps;
};

export const isAbortError = (error: unknown) =>
  (error instanceof Error && error.name === "AbortError") ||
  (error as { code?: string } | null)?.code === "abort";

/**
 * Stage 1: read the scribble. Never retried automatically; every failure is
 * converted into a localized, redacted message.
 */
export const runRorschachReading = async ({
  attempt,
  agent,
  systemPrompt,
  userPrompt,
  locale,
  signal,
  parse,
  isCurrent,
  onPatch,
  deps,
}: RunRorschachReadingOptions) => {
  const describe = deps?.describe || describeImageWithVisionAgent;

  onPatch(attempt.id, {
    readingStatus: "running",
    readingError: null,
    imageError: null,
    imageStatus: "idle",
    result: null,
    imageOutput: null,
  });

  try {
    const { text } = await describe({
      agent,
      image: attempt.image,
      systemPrompt,
      userPrompt,
      signal,
    });

    if (!isCurrent()) {
      return null;
    }

    let result: RorschachReading;
    try {
      result = parse(text, locale);
    } catch (error) {
      onPatch(attempt.id, {
        readingStatus: "failed",
        readingError: t("labs.rorschach.errors.invalidReading"),
      });
      return null;
    }

    onPatch(attempt.id, {
      readingStatus: "succeeded",
      result,
      readingError: null,
    });
    return result;
  } catch (error) {
    if (!isCurrent()) {
      return null;
    }
    onPatch(attempt.id, {
      readingStatus: signal.aborted ? "cancelled" : "failed",
      readingError: signal.aborted
        ? t("labs.rorschach.errors.cancelled")
        : describeErrorMessage(error),
    });
    return null;
  }
};

export const describeErrorMessage = (error: unknown) => {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AIProxyTransportError") {
    const code = (error as { code?: string }).code;
    if (code === "proxy-config") {
      return (
        (error as Error).message || t("labs.rorschach.errors.transportConfig")
      );
    }
    return (
      (error as Error).message || t("labs.rorschach.errors.transportFailed")
    );
  }
  if (name === "AIImageGenerationError") {
    const code = (error as { code?: string }).code;
    if (code === "proxy-config") {
      return (
        (error as Error).message || t("labs.rorschach.errors.transportConfig")
      );
    }
  }
  const message =
    error instanceof Error ? (error.message || "").trim() : String(error || "");
  // Provider messages are shown as-is by the existing adapters, but never
  // echo anything that looks like a secret or a full URL.
  if (/api[-_ ]?key|bearer\s|https?:\/\//i.test(message)) {
    return t("labs.rorschach.errors.requestFailed");
  }
  return message || t("labs.rorschach.errors.requestFailed");
};

export const toRorschachImageOutput = (
  output: {
    dataURL: string;
    mimeType: string;
    storageType?: "data-url" | "remote-url";
    revisedPrompt?: string;
  } | null,
): RorschachImageOutput | null => {
  if (!output || typeof output.dataURL !== "string") {
    return null;
  }
  if (!output.dataURL.startsWith("data:image/")) {
    return null;
  }
  return {
    dataURL: output.dataURL,
    mimeType: output.mimeType || "image/png",
    ...(output.storageType ? { storageType: output.storageType } : {}),
    ...(output.revisedPrompt ? { revisedPrompt: output.revisedPrompt } : {}),
  };
};

/** Keeps the prompt sent to the model bounded across "read again" rounds. */
export const pushRorschachHistory = (
  history: readonly string[],
  reading: string,
  limit: number,
) => {
  const next = [...history, reading].filter(Boolean);
  return next.length > limit ? next.slice(next.length - limit) : next;
};
