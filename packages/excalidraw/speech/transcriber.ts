import { EDITOR_LS_KEYS } from "@excalidraw/common";

import { EditorLocalStorage } from "../data/EditorLocalStorage";

import { cleanTranscriptSegment, joinTranscriptSegments } from "./clean";

// Live transcription through the browser's Web Speech API (ADR 0034 §7).
//
// Path B (`start(track)`) feeds the recognizer the very track we record, so
// it honours the mic picker; Chrome needs it. Path A (`start()`) lets the
// browser open its own default microphone; Edge needs it, because it accepts
// a track but silently returns empty finals. Neither can be feature-detected,
// so we start on B, watch for "sound but no text", fall back to A, and
// remember what worked per browser brand + major version.

export type SpeechPath = "track" | "default";

export type TranscriptionMode = "auto" | "local-only";

type SpeechAlternativeLike = { transcript: string };
type SpeechResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
};
type SpeechResultEventLike = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechResultLike;
  };
};

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};

export type LocalSpeechAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export type SpeechRecognitionCtor = {
  new (): SpeechRecognitionLike;
  available?: (options: {
    langs: string[];
    processLocally: boolean;
  }) => Promise<LocalSpeechAvailability>;
  install?: (options: {
    langs: string[];
    processLocally: boolean;
  }) => Promise<boolean>;
};

export const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

// -----------------------------------------------------------------------------
// remembered path per browser

const getBrowserKey = () => {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const brands: { brand: string; version: string }[] =
    (navigator as any).userAgentData?.brands ?? [];
  const brand = brands.find(
    (entry) => !/not.?a.?brand|chromium/i.test(entry.brand),
  );
  if (brand) {
    return `${brand.brand}/${brand.version.split(".")[0]}`;
  }
  const match = navigator.userAgent.match(/(Edg|Chrome|Firefox)\/(\d+)/);
  return match ? `${match[1]}/${match[2]}` : "unknown";
};

const readRememberedPaths = () =>
  EditorLocalStorage.get<Record<string, SpeechPath>>(
    EDITOR_LS_KEYS.VOICE_SPEECH_PATHS,
  ) ?? {};

export const getRememberedSpeechPath = (
  key = getBrowserKey(),
): SpeechPath | null => readRememberedPaths()[key] ?? null;

export const rememberSpeechPath = (path: SpeechPath, key = getBrowserKey()) => {
  const paths = readRememberedPaths();
  if (paths[key] !== path) {
    EditorLocalStorage.set(EDITOR_LS_KEYS.VOICE_SPEECH_PATHS, {
      ...paths,
      [key]: path,
    });
  }
};

// -----------------------------------------------------------------------------
// on-device recognition (Vault mode)

/** `unavailable` also covers browsers without the on-device API at all. */
export const getLocalSpeechAvailability = async (
  lang: string,
  ctor: SpeechRecognitionCtor | null = getSpeechRecognitionCtor(),
): Promise<LocalSpeechAvailability> => {
  // `available()` shipped together with `processLocally`; without it we
  // can't guarantee audio stays on the device, so local-only fails closed
  if (!ctor?.available) {
    return "unavailable";
  }
  try {
    return await ctor.available({ langs: [lang], processLocally: true });
  } catch {
    return "unavailable";
  }
};

/** Downloads the on-device language pack; only call after user consent. */
export const installLocalSpeech = async (
  lang: string,
  ctor: SpeechRecognitionCtor | null = getSpeechRecognitionCtor(),
) => {
  if (!ctor?.install) {
    return false;
  }
  try {
    return await ctor.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
};
// -----------------------------------------------------------------------------
// transcriber

/** input level (0..1, as `VoiceRecorder.level()`) that counts as speech */
const SPEECH_LEVEL = 0.15;
/** this much loud input without any text means the path hears nothing */
const SILENT_PATH_TIMEOUT = 3_000;
const EMPTY_FINALS_LIMIT = 2;
const LEVEL_POLL_INTERVAL = 100;
/** the last final can arrive ~1 s after stop (ADR 0034 §7) */
export const TRANSCRIBER_FINISH_TIMEOUT = 2_000;
/** sessions shorter than this count towards the restart limit */
const QUICK_SESSION = 1_000;
const MAX_QUICK_RESTARTS = 5;

const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
  "audio-capture",
  "network",
  "bad-grammar",
]);

export type TranscriptUpdate = {
  /** cleaned final text so far */
  final: string;
  /** cleaned interim text of the current utterance, shown greyed */
  interim: string;
};

export type Transcriber = {
  readonly path: SpeechPath;
  /** stops listening and resolves the cleaned text once the last final came */
  finish(): Promise<string>;
  /** stops at once; returns the final text so far (interim is dropped) */
  abort(): string;
};

export const createTranscriber = (opts: {
  /** the recorded track, for path B; without one only path A is possible */
  track: MediaStreamTrack | null;
  lang: string;
  mode: TranscriptionMode;
  /** live input level in 0..1, for the B→A fallback heuristic */
  getLevel?: () => number;
  onUpdate?: (update: TranscriptUpdate) => void;
  /** recognition can't run at all (permission, language, network…) */
  onUnavailable?: (error: string) => void;
  /** injectable for tests; `null` means unsupported */
  recognitionCtor?: SpeechRecognitionCtor | null;
  now?: () => number;
  browserKey?: string;
}): Transcriber | null => {
  const Ctor =
    opts.recognitionCtor === undefined
      ? getSpeechRecognitionCtor()
      : opts.recognitionCtor;
  if (!Ctor) {
    return null;
  }
  const now = opts.now ?? (() => Date.now());
  const browserKey = opts.browserKey ?? getBrowserKey();
  const track = opts.track;

  let path: SpeechPath = track
    ? getRememberedSpeechPath(browserKey) ?? "track"
    : "default";
  const triedPaths = new Set<SpeechPath>([path]);
  let recognition: SpeechRecognitionLike | null = null;
  let state: "running" | "finishing" | "done" = "running";
  /** finals of earlier recognizer sessions */
  let committed = "";
  let sessionFinal = "";
  let interim = "";
  let fatalError: string | null = null;
  // fallback heuristic, only until the current path has produced text
  let checking = true;
  let loudMs = 0;
  let emptyFinals = 0;
  let sessionStartedAt = 0;
  let quickRestarts = 0;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveFinish: ((text: string) => void) | null = null;
  let finishPromise: Promise<string> | null = null;

  const finalText = () => joinTranscriptSegments(committed, sessionFinal);

  const emit = () => opts.onUpdate?.({ final: finalText(), interim });

  const detach = (target: SpeechRecognitionLike | null) => {
    if (target) {
      target.onresult = null;
      target.onerror = null;
      target.onend = null;
    }
  };

  const markHeard = () => {
    quickRestarts = 0;
    if (checking) {
      checking = false;
      if (track) {
        rememberSpeechPath(path, browserKey);
      }
    }
  };

  const done = () => {
    state = "done";
    clearInterval(levelTimer);
    if (finishTimer) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
    resolveFinish?.(committed);
    resolveFinish = null;
  };

  const switchPath = (next: SpeechPath) => {
    triedPaths.add(next);
    path = next;
    checking = true;
    loudMs = 0;
    emptyFinals = 0;
    quickRestarts = 0;
    const previous = recognition;
    recognition = null;
    committed = finalText();
    sessionFinal = "";
    interim = "";
    detach(previous);
    try {
      previous?.abort();
    } catch {}
    emit();
    startRecognition();
  };

  /** the current path hears nothing: try the other one, once */
  const fallBack = () => {
    const other: SpeechPath = path === "track" ? "default" : "track";
    if (triedPaths.has(other) || (other === "track" && !track)) {
      checking = false;
      return;
    }
    switchPath(other);
  };

  const startRecognition = () => {
    const target = new Ctor();
    target.lang = opts.lang;
    target.continuous = true;
    target.interimResults = true;
    if (opts.mode === "local-only") {
      target.processLocally = true;
    }
    sessionFinal = "";
    interim = "";

    target.onresult = (event) => {
      if (recognition !== target) {
        return;
      }
      const finals: string[] = [];
      let interimText = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finals.push(text);
          if (i >= event.resultIndex) {
            emptyFinals = cleanTranscriptSegment(text) ? 0 : emptyFinals + 1;
          }
        } else {
          interimText += text;
        }
      }
      sessionFinal = finals
        .map(cleanTranscriptSegment)
        .filter(Boolean)
        .reduce(joinTranscriptSegments, "");
      interim = cleanTranscriptSegment(interimText);
      if (sessionFinal || interim) {
        markHeard();
        loudMs = 0;
      }
      emit();
      if (
        checking &&
        state === "running" &&
        emptyFinals >= EMPTY_FINALS_LIMIT
      ) {
        fallBack();
      }
    };

    target.onerror = (event) => {
      if (recognition === target && FATAL_ERRORS.has(event.error)) {
        fatalError = event.error;
      }
    };

    target.onend = () => {
      if (recognition !== target) {
        return;
      }
      recognition = null;
      committed = finalText();
      sessionFinal = "";
      interim = "";
      if (state === "finishing") {
        done();
        return;
      }
      if (state === "done") {
        return;
      }
      if (fatalError) {
        const error = fatalError;
        done();
        emit();
        opts.onUnavailable?.(error);
        return;
      }
      // Chrome ends a continuous session after a pause: carry on listening
      quickRestarts =
        now() - sessionStartedAt < QUICK_SESSION ? quickRestarts + 1 : 0;
      if (
        quickRestarts > MAX_QUICK_RESTARTS ||
        (path === "track" && track?.readyState === "ended")
      ) {
        done();
        emit();
        return;
      }
      emit();
      startRecognition();
    };

    recognition = target;
    sessionStartedAt = now();
    try {
      if (path === "track" && track) {
        target.start(track);
      } else {
        target.start();
      }
    } catch (error) {
      recognition = null;
      detach(target);
      if (path === "track" && !triedPaths.has("default")) {
        switchPath("default");
        return;
      }
      done();
      opts.onUnavailable?.("start-failed");
    }
  };

  const levelTimer = setInterval(() => {
    if (state !== "running" || !checking || !opts.getLevel) {
      return;
    }
    if (opts.getLevel() >= SPEECH_LEVEL) {
      loudMs += LEVEL_POLL_INTERVAL;
      if (loudMs >= SILENT_PATH_TIMEOUT) {
        fallBack();
      }
    }
  }, LEVEL_POLL_INTERVAL);

  startRecognition();

  return {
    get path() {
      return path;
    },
    finish: () => {
      if (finishPromise) {
        return finishPromise;
      }
      if (state === "done") {
        finishPromise = Promise.resolve(committed);
        return finishPromise;
      }
      state = "finishing";
      clearInterval(levelTimer);
      finishPromise = new Promise<string>((resolve) => {
        resolveFinish = resolve;
        const target = recognition;
        if (!target) {
          done();
          return;
        }
        finishTimer = setTimeout(() => {
          // the last final never came: keep the words we already saw
          recognition = null;
          committed = joinTranscriptSegments(finalText(), interim);
          sessionFinal = "";
          interim = "";
          detach(target);
          try {
            target.abort();
          } catch {}
          done();
        }, TRANSCRIBER_FINISH_TIMEOUT);
        try {
          target.stop();
        } catch {
          target.onend?.();
        }
      });
      return finishPromise;
    },
    abort: () => {
      const text = finalText();
      const target = recognition;
      recognition = null;
      committed = text;
      sessionFinal = "";
      interim = "";
      detach(target);
      try {
        target?.abort();
      } catch {}
      done();
      return text;
    },
  };
};
