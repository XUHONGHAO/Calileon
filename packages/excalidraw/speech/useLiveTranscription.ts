import { useCallback, useEffect, useRef, useState } from "react";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { joinTranscriptSegments } from "./clean";
import { getSpeechLang } from "./lang";
import {
  hasSeenTranscriptionNotice,
  isTranscriptionTurnedOff,
  markTranscriptionNoticeSeen,
  setTranscriptionTurnedOff,
} from "./prefs";
import {
  createTranscriber,
  getLocalSpeechAvailability,
  getSpeechRecognitionCtor,
  installLocalSpeech,
} from "./transcriber";

import type { VoiceRecorder } from "../voice/recorder";

import type { Transcriber, TranscriptUpdate } from "./transcriber";
import type { VoiceOptions } from "../types";

export type LiveTranscriptionStatus =
  /** no recognizer in this browser, or the host turned transcription off */
  | "unsupported"
  /** the user turned it off */
  | "off"
  /** first use, cloud path: waiting for the user to read the privacy notice */
  | "notice"
  /** local-only: asking the browser whether an on-device model exists */
  | "checking"
  /** local-only: a language pack must be downloaded, waiting for consent */
  | "consent"
  | "downloading"
  | "listening"
  /** local-only without a model, or recognition failed for this session */
  | "unavailable";

const EMPTY_UPDATE: TranscriptUpdate = { final: "", interim: "" };

const getInitialStatus = (
  mode: VoiceOptions["transcription"],
): LiveTranscriptionStatus => {
  if (mode === "off" || !getSpeechRecognitionCtor()) {
    return "unsupported";
  }
  if (isTranscriptionTurnedOff()) {
    return "off";
  }
  if (mode === "local-only") {
    return "checking";
  }
  return hasSeenTranscriptionNotice() ? "listening" : "notice";
};

/**
 * Live transcription of the voice recording (ADR 0034 §7): privacy notice,
 * Vault on-device gate, language switch and the final transcript snapshot.
 * Recognition never blocks recording; every failure just means no text.
 */
export const useLiveTranscription = ({
  recorder,
  mode = "auto",
  langCode,
}: {
  /** the running recorder; a new one (device switch) starts a new transcript */
  recorder: VoiceRecorder | null;
  mode?: VoiceOptions["transcription"];
  langCode: string;
}) => {
  const [status, setStatus] = useState<LiveTranscriptionStatus>(() =>
    getInitialStatus(mode),
  );
  const [lang, setLangState] = useState(() => getSpeechLang(langCode));
  const [update, setUpdate] = useState<TranscriptUpdate>(EMPTY_UPDATE);
  const [failure, setFailure] = useState<string | null>(null);
  const transcriberRef = useRef<Transcriber | null>(null);
  /** finals from transcribers that were replaced (language switch) */
  const committedRef = useRef("");
  const recognitionMode = mode === "local-only" ? "local-only" : "auto";

  // a new recorder (device switch) threw the earlier audio away, and its text
  useEffect(() => {
    if (recorder) {
      committedRef.current = "";
      setUpdate(EMPTY_UPDATE);
    }
  }, [recorder]);

  // Vault: is there an on-device model for this language?
  useEffect(() => {
    if (status !== "checking") {
      return;
    }
    let cancelled = false;
    getLocalSpeechAvailability(lang).then((availability) => {
      if (cancelled) {
        return;
      }
      setStatus(
        availability === "available"
          ? "listening"
          : availability === "downloadable"
          ? "consent"
          : availability === "downloading"
          ? "downloading"
          : "unavailable",
      );
    });
    return () => {
      cancelled = true;
    };
  }, [status, lang]);

  // another tab may be downloading the pack already; wait for it
  useEffect(() => {
    if (status !== "downloading") {
      return;
    }
    let cancelled = false;
    installLocalSpeech(lang).then((installed) => {
      if (!cancelled) {
        setStatus(installed ? "listening" : "unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, lang]);

  useEffect(() => {
    if (status !== "listening" || !recorder) {
      return;
    }
    const transcriber = createTranscriber({
      track: recorder.track,
      lang,
      mode: recognitionMode,
      getLevel: () => recorder.level(),
      onUpdate: (next) =>
        setUpdate({
          final: joinTranscriptSegments(committedRef.current, next.final),
          interim: next.interim,
        }),
      onUnavailable: (error) => {
        setFailure(error);
        setStatus("unavailable");
      },
    });
    if (!transcriber) {
      setStatus("unsupported");
      return;
    }
    transcriberRef.current = transcriber;
    return () => {
      // `finish()` takes ownership by clearing the ref first
      if (transcriberRef.current === transcriber) {
        transcriberRef.current = null;
        committedRef.current = joinTranscriptSegments(
          committedRef.current,
          transcriber.abort(),
        );
      }
    };
  }, [status, recorder, lang, recognitionMode]);

  const setLang = useCallback(
    (next: string) => {
      setLangState(next);
      if (recognitionMode === "local-only" && status !== "off") {
        setStatus("checking");
      }
    },
    [recognitionMode, status],
  );

  const toggle = useCallback(() => {
    if (status === "unsupported") {
      return;
    }
    if (status === "off") {
      setTranscriptionTurnedOff(false);
      setFailure(null);
      setStatus(getInitialStatus(mode));
      return;
    }
    // turning it off drops this recording's transcript too
    setTranscriptionTurnedOff(true);
    transcriberRef.current?.abort();
    transcriberRef.current = null;
    committedRef.current = "";
    setUpdate(EMPTY_UPDATE);
    setStatus("off");
  }, [mode, status]);

  const acceptNotice = useCallback(() => {
    markTranscriptionNoticeSeen();
    setStatus("listening");
  }, []);

  const decline = useCallback(() => {
    if (status === "notice") {
      markTranscriptionNoticeSeen();
    }
    setTranscriptionTurnedOff(true);
    setStatus("off");
  }, [status]);

  const acceptDownload = useCallback(() => {
    setStatus("downloading");
  }, []);

  /** stops recognition and returns the transcript to store on the element */
  const finish = useCallback(async (): Promise<
    ExcalidrawAudioElement["transcript"]
  > => {
    const transcriber = transcriberRef.current;
    transcriberRef.current = null;
    const committed = committedRef.current;
    const last = transcriber ? await transcriber.finish() : "";
    const text = joinTranscriptSegments(committed, last).trim();
    return text ? { text, lang, mode: recognitionMode } : null;
  }, [lang, recognitionMode]);

  return {
    status,
    failure,
    lang,
    setLang,
    update,
    toggle,
    acceptNotice,
    decline,
    acceptDownload,
    finish,
  };
};
