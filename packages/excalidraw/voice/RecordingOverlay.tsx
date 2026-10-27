import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  AUDIO_RECORDING_MAX_DURATION,
  EDITOR_LS_KEYS,
  KEYS,
  sceneCoordsToViewportCoords,
} from "@excalidraw/common";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { EditorLocalStorage } from "../data/EditorLocalStorage";
import { t } from "../i18n";
import { useExcalidrawAppState } from "../components/App";
import {
  TrashIcon,
  microphoneIcon,
  playerStopFilledIcon,
} from "../components/icons";
import { joinTranscriptSegments } from "../speech/clean";
import { SPEECH_LANGUAGES } from "../speech/lang";
import { useLiveTranscription } from "../speech/useLiveTranscription";

import { acquireMicLock } from "./micLock";
import { VoiceSelect } from "./VoiceSelect";
import {
  VoiceRecorderFailure,
  listMicrophones,
  startVoiceRecorder,
} from "./recorder";

import "./VoiceOverlays.scss";

import type { VoiceOptions } from "../types";

import type { VoiceSession } from "./atoms";
import type {
  VoiceRecorder,
  VoiceRecorderError,
  VoiceRecording,
} from "./recorder";

type Phase =
  | { kind: "requesting" }
  | { kind: "recording" }
  | { kind: "saving" }
  | { kind: "error"; reason: VoiceRecorderError };

const OVERLAY_HEIGHT = 48;
/** live caption shows the tail of the transcript, one line */
const CAPTION_CHARS = 48;
/** the red dot sits on the click point, where the bubble's avatar will be */
const DOT_OFFSET = 18;
const WAVE_BARS = 36;
const WAVE_WIDTH = 108;
const WAVE_HEIGHT = 24;

const formatClock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

const drawWave = (
  canvas: HTMLCanvasElement,
  levels: readonly number[],
  reducedMotion: boolean,
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== WAVE_WIDTH * dpr) {
    canvas.width = WAVE_WIDTH * dpr;
    canvas.height = WAVE_HEIGHT * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, WAVE_WIDTH, WAVE_HEIGHT);
  ctx.fillStyle = getComputedStyle(canvas).color;
  if (reducedMotion) {
    // a single, slowly updated level meter instead of a scrolling waveform
    const level = levels[levels.length - 1] ?? 0;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, WAVE_HEIGHT / 2 - 3, WAVE_WIDTH, 6);
    ctx.globalAlpha = 1;
    ctx.fillRect(0, WAVE_HEIGHT / 2 - 3, Math.max(2, level * WAVE_WIDTH), 6);
    return;
  }
  const step = WAVE_WIDTH / WAVE_BARS;
  for (let i = 0; i < WAVE_BARS; i++) {
    const level = levels[levels.length - WAVE_BARS + i] ?? 0;
    const height = Math.max(2, Math.round(level * WAVE_HEIGHT));
    ctx.fillRect(i * step, (WAVE_HEIGHT - height) / 2, 2, height);
  }
};

const getCaptionTail = (text: string) => {
  const chars = Array.from(text);
  return chars.length > CAPTION_CHARS
    ? `…${chars.slice(-CAPTION_CHARS).join("")}`
    : text;
};

export const RecordingOverlay = ({
  session,
  transcription,
  langCode,
  onFinish,
  onCancel,
}: {
  session: VoiceSession;
  transcription?: VoiceOptions["transcription"];
  /** editor language; the recognition language defaults to it */
  langCode: string;
  /** inserts the recording; resolves once the element is on the canvas */
  onFinish: (
    recording: VoiceRecording,
    transcript: ExcalidrawAudioElement["transcript"],
  ) => Promise<void>;
  /** ends the session without inserting anything */
  onCancel: () => void;
}) => {
  const appState = useExcalidrawAppState();
  const [phase, setPhase] = useState<Phase>({ kind: "requesting" });
  const [deviceId, setDeviceId] = useState<string | null>(() =>
    EditorLocalStorage.get<string>(EDITOR_LS_KEYS.VOICE_INPUT_DEVICE),
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  // state too, so a new recorder (device switch) restarts transcription
  const [recorder, setRecorder] = useState<VoiceRecorder | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 300, height: OVERLAY_HEIGHT });
  const stopRef = useRef<() => void>(() => {});
  const speech = useLiveTranscription({
    recorder,
    mode: transcription,
    langCode,
  });
  const finishSpeech = speech.finish;

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
    recorderRef.current = null;
    setPhase({ kind: "saving" });
    try {
      // ask for the last final before the track goes away
      const transcriptPromise = finishSpeech().catch(() => null);
      const recording = await recorder.stop();
      const transcript = await transcriptPromise;
      await onFinish(recording, transcript);
    } catch (error) {
      console.error(error);
      onCancel();
    }
  }, [onFinish, onCancel, finishSpeech]);
  stopRef.current = stop;

  // open the microphone; switching devices restarts the recording
  useEffect(() => {
    const release = acquireMicLock("voice-recording");
    if (!release) {
      setPhase({ kind: "error", reason: "busy" });
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: "requesting" });
    setElapsed(0);
    startVoiceRecorder({
      deviceId,
      signal: controller.signal,
      onAutoStop: () => stopRef.current(),
      // keep what was recorded when the device goes away mid-sentence
      onInterrupted: () => stopRef.current(),
    })
      .then((recorder) => {
        if (controller.signal.aborted) {
          recorder.discard();
          return;
        }
        recorderRef.current = recorder;
        setRecorder(recorder);
        setPhase({ kind: "recording" });
        // labels are only exposed after permission was granted
        listMicrophones().then((list) => {
          if (!controller.signal.aborted) {
            setDevices(list);
          }
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        release();
        setPhase({
          kind: "error",
          reason:
            error instanceof VoiceRecorderFailure ? error.reason : "audioError",
        });
      });
    return () => {
      controller.abort();
      recorderRef.current?.discard();
      recorderRef.current = null;
      setRecorder(null);
      release();
    };
  }, [deviceId, session.id]);

  // live waveform + timer
  useEffect(() => {
    if (phase.kind !== "recording") {
      return;
    }
    const reducedMotion = prefersReducedMotion();
    const levels: number[] = [];
    let frame = 0;
    let lastDraw = 0;
    let lastClock = 0;
    const tick = (time: number) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        return;
      }
      if (time - lastDraw >= (reducedMotion ? 300 : 50)) {
        lastDraw = time;
        levels.push(recorder.level());
        if (levels.length > WAVE_BARS) {
          levels.shift();
        }
        if (waveRef.current) {
          drawWave(waveRef.current, levels, reducedMotion);
        }
      }
      if (time - lastClock >= 250) {
        lastClock = time;
        setElapsed(recorder.elapsed());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase.kind]);

  // Esc discards; a hidden page discards so nothing records in the background
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // an open dropdown closes itself first; Esc again discards
      const openSelect =
        event.target instanceof Element &&
        event.target.closest(".excalidraw-voice-select[data-open]");
      if (event.key === KEYS.ESCAPE && !openSelect) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onCancel]);

  // the pill grows with the transcription controls and the caption below it
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) {
      return;
    }
    const measure = () => {
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { x: viewportX, y: viewportY } = sceneCoordsToViewportCoords(
    { sceneX: session.sceneX, sceneY: session.sceneY },
    appState,
  );
  const left = Math.max(
    8,
    Math.min(
      viewportX - appState.offsetLeft - DOT_OFFSET,
      appState.width - size.width - 8,
    ),
  );
  const top = Math.max(
    8,
    Math.min(
      viewportY - appState.offsetTop - OVERLAY_HEIGHT / 2,
      appState.height - size.height - 8,
    ),
  );

  const remaining = Math.max(
    0,
    Math.ceil((AUDIO_RECORDING_MAX_DURATION - elapsed) / 1000),
  );
  const status =
    phase.kind === "error"
      ? t(`voice.errors.${phase.reason}`)
      : phase.kind === "requesting"
      ? t("voice.requesting")
      : phase.kind === "saving"
      ? t("voice.saving")
      : t("voice.recording");

  const speechVisible =
    phase.kind !== "error" && speech.status !== "unsupported";
  const speechOn = speech.status !== "off" && speech.status !== "unsupported";
  const languages = SPEECH_LANGUAGES.some(({ code }) => code === speech.lang)
    ? SPEECH_LANGUAGES
    : [...SPEECH_LANGUAGES, { code: speech.lang, label: speech.lang }];
  const deviceOptions = devices.map((device, index) => ({
    value: device.deviceId,
    label: device.label || `${t("voice.microphone")} ${index + 1}`,
  }));
  const selectedDeviceId = recorderRef.current?.deviceId ?? deviceId ?? "";
  const selectedDeviceLabel =
    deviceOptions.find((option) => option.value === selectedDeviceId)?.label ??
    t("voice.microphone");

  const renderCaption = () => {
    if (!speechVisible) {
      return null;
    }
    switch (speech.status) {
      case "notice":
      case "consent":
        return (
          <div
            className="excalidraw-voice-recorder__caption excalidraw-voice-recorder__caption--notice"
            role="status"
          >
            <span>
              {t(
                speech.status === "notice"
                  ? "voice.transcription.notice"
                  : "voice.transcription.downloadConsent",
              )}
            </span>
            <span className="excalidraw-voice-recorder__caption-actions">
              <button
                type="button"
                className="excalidraw-voice-recorder__button excalidraw-voice-recorder__button--primary"
                onClick={
                  speech.status === "notice"
                    ? speech.acceptNotice
                    : speech.acceptDownload
                }
              >
                {t(
                  speech.status === "notice"
                    ? "voice.transcription.accept"
                    : "voice.transcription.download",
                )}
              </button>
              <button
                type="button"
                className="excalidraw-voice-recorder__button"
                onClick={speech.decline}
              >
                {t("voice.transcription.decline")}
              </button>
            </span>
          </div>
        );
      case "downloading":
      case "unavailable":
        return (
          <div className="excalidraw-voice-recorder__caption excalidraw-voice-recorder__caption--muted">
            {speech.status === "downloading"
              ? t("voice.transcription.downloading")
              : t(
                  transcription === "local-only" && !speech.failure
                    ? "voice.transcription.localUnavailable"
                    : "voice.transcription.failed",
                )}
          </div>
        );
      case "listening": {
        if (phase.kind !== "recording" && phase.kind !== "saving") {
          return null;
        }
        const { final, interim } = speech.update;
        const text = getCaptionTail(joinTranscriptSegments(final, interim));
        const interimStart = Math.max(0, text.length - interim.length);
        return (
          <div
            className="excalidraw-voice-recorder__caption"
            aria-hidden="true"
          >
            {text ? (
              <>
                {text.slice(0, interimStart)}
                <span className="excalidraw-voice-recorder__interim">
                  {text.slice(interimStart)}
                </span>
              </>
            ) : (
              <span className="excalidraw-voice-recorder__interim">
                {t("voice.transcription.listening")}
              </span>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div
      ref={rootRef}
      className="excalidraw-voice-recorder"
      style={{ left, top }}
      role="group"
      aria-label={t("voice.recordingLabel")}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className={clsx("excalidraw-voice-recorder__pill", {
          "excalidraw-voice-recorder__pill--error": phase.kind === "error",
        })}
      >
        <span className="visually-hidden" aria-live="polite">
          {status}
        </span>
        {phase.kind === "error" ? (
          <>
            <span className="excalidraw-voice-recorder__message" role="alert">
              {status}
            </span>
            <button
              type="button"
              className="excalidraw-voice-recorder__button"
              onClick={onCancel}
            >
              {t("buttons.close")}
            </button>
          </>
        ) : (
          <>
            <span
              className={clsx("excalidraw-voice-recorder__dot", {
                "excalidraw-voice-recorder__dot--live":
                  phase.kind === "recording",
              })}
              aria-hidden="true"
            />
            <span className="excalidraw-voice-recorder__clock">
              {phase.kind === "recording"
                ? `${formatClock(elapsed)} / ${formatClock(
                    AUDIO_RECORDING_MAX_DURATION,
                  )}`
                : status}
            </span>
            <canvas
              ref={waveRef}
              className="excalidraw-voice-recorder__wave"
              style={{ width: WAVE_WIDTH, height: WAVE_HEIGHT }}
              aria-hidden="true"
            />
            {phase.kind === "recording" && remaining <= 10 && (
              <span className="excalidraw-voice-recorder__remaining">
                {t("voice.remaining", { seconds: remaining })}
              </span>
            )}
            {speechVisible && (
              <button
                type="button"
                className={clsx(
                  "excalidraw-voice-recorder__icon-button excalidraw-voice-recorder__transcribe",
                  {
                    "excalidraw-voice-recorder__transcribe--on": speechOn,
                  },
                )}
                aria-pressed={speechOn}
                title={t(
                  speechOn
                    ? "voice.transcription.turnOff"
                    : "voice.transcription.turnOn",
                )}
                aria-label={t("voice.transcription.label")}
                onClick={speech.toggle}
                disabled={phase.kind === "saving"}
              >
                文
              </button>
            )}
            {speechVisible && speechOn && (
              <VoiceSelect
                className="excalidraw-voice-recorder__lang"
                aria-label={t("voice.transcription.language")}
                value={speech.lang}
                options={languages.map(({ code, label }) => ({
                  value: code,
                  label,
                }))}
                onChange={speech.setLang}
                disabled={phase.kind === "saving"}
              />
            )}
            {devices.length > 1 && phase.kind === "recording" && (
              <VoiceSelect
                className="excalidraw-voice-recorder__device"
                aria-label={t("voice.microphone")}
                title={`${selectedDeviceLabel} · ${t(
                  "voice.switchMicrophoneHint",
                )}`}
                value={selectedDeviceId}
                options={deviceOptions}
                placeholder={t("voice.microphone")}
                icon={microphoneIcon}
                onChange={(next) => {
                  EditorLocalStorage.set(
                    EDITOR_LS_KEYS.VOICE_INPUT_DEVICE,
                    next,
                  );
                  setDeviceId(next);
                }}
              />
            )}
            <button
              type="button"
              className="excalidraw-voice-recorder__icon-button"
              title={t("voice.discard")}
              aria-label={t("voice.discard")}
              onClick={onCancel}
              disabled={phase.kind === "saving"}
            >
              {TrashIcon}
            </button>
            <button
              type="button"
              className="excalidraw-voice-recorder__icon-button excalidraw-voice-recorder__stop"
              title={t("voice.stop")}
              aria-label={t("voice.stop")}
              onClick={() => stop()}
              disabled={phase.kind !== "recording"}
            >
              {playerStopFilledIcon}
            </button>
          </>
        )}
      </div>
      {renderCaption()}
    </div>
  );
};
