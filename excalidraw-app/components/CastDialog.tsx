import {
  CaptureUpdateAction,
  Excalidraw,
  ExcalidrawAPIProvider,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { Range } from "@excalidraw/excalidraw/components/Range";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { EditorLocalStorage } from "@excalidraw/excalidraw/data/EditorLocalStorage";
import { t } from "@excalidraw/excalidraw/i18n";
import { EDITOR_LS_KEYS, getVersion } from "@excalidraw/common";
import { getCommonBounds } from "@excalidraw/element";
import React from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawProps,
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";

import { useCloudAuth } from "../auth/useCloudAuth";
import {
  CastPlayer,
  CastRecorder,
  UnsupportedCastVersionError,
  createNarrationURL,
  deserializeCastScript,
  isNarrationPreferred,
  saveCastScriptToCloud,
  serializeCastScript,
  setNarrationPreferred,
  startCastNarration,
  subscribeCastPointerUpdate,
  syncNarration,
} from "../cast";

import { getCloudBackend } from "../data/cloud";

import { CastRecordingBar } from "./CastRecordingBar";
import { Badge, Callout, SegmentedControl, UiButton } from "./ui";

import "./CastDialog.scss";

import type {
  CastNarrationSession,
  CastPlaybackSnapshot,
  CastRecorderState,
  CastSceneSnapshot,
  CastScriptV1,
} from "../cast";

import type { ActiveCloudSceneInfo } from "./AuthDialog";

const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;

const readSceneSnapshot = (
  excalidrawAPI: ExcalidrawImperativeAPI,
): CastSceneSnapshot => ({
  elements: excalidrawAPI.getSceneElements(),
  appState: excalidrawAPI.getAppState(),
  files: excalidrawAPI.getFiles(),
});

const toPreviewAppState = (
  appState: CastPlaybackSnapshot["appState"],
): AppState =>
  ({
    ...getDefaultAppState(),
    ...appState,
    zoom: { value: appState.zoom as NormalizedZoomValue },
    viewModeEnabled: true,
    luminaGameMode: null,
    exportIncludeGameEffects: false,
  } as AppState);

type PreviewViewMode = "fit" | "follow";

const FIT_PADDING = 32;
const FIT_MAX_ZOOM = 1;
const FIT_MIN_ZOOM = 0.1;

/**
 * Scroll/zoom that shows everything the recording ever draws inside a
 * `width`×`height` preview. The recorded viewport belongs to the (larger) main
 * canvas, so replaying it 1:1 crops the drawing.
 */
const getFitViewport = (
  elements: readonly ExcalidrawElement[],
  width: number,
  height: number,
) => {
  if (!elements.length || width <= 0 || height <= 0) {
    return null;
  }
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const zoom = Math.min(
    FIT_MAX_ZOOM,
    Math.max(
      FIT_MIN_ZOOM,
      Math.min(
        (width - FIT_PADDING * 2) / contentWidth,
        (height - FIT_PADDING * 2) / contentHeight,
      ),
    ),
  );
  return {
    zoom,
    scrollX: width / 2 / zoom - (minX + contentWidth / 2),
    scrollY: height / 2 / zoom - (minY + contentHeight / 2),
  };
};

const formatTime = (timeMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const downloadScript = (script: CastScriptV1) => {
  const blob = new Blob([serializeCastScript(script)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeTitle = script.title.replace(/[^a-z0-9-_]+/gi, "-") || "cast";
  anchor.href = url;
  anchor.download = `${safeTitle}.calileon-cast.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const CastDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  activeCloudScene?: ActiveCloudSceneInfo | null;
  langCode?: ExcalidrawProps["langCode"];
}> = ({ open, onClose, excalidrawAPI, activeCloudScene, langCode }) => {
  const cloudAuth = useCloudAuth();
  const recorderRef = React.useRef<CastRecorder | null>(null);
  const lastPointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const previewAPIRef = React.useRef<ExcalidrawImperativeAPI | null>(null);
  const previewContainerRef = React.useRef<HTMLDivElement | null>(null);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  const animationFrameRef = React.useRef<number | null>(null);
  const playbackAnchorRef = React.useRef({ at: 0, startedAt: 0 });
  const currentTimeRef = React.useRef(0);
  const lastEphemeralSceneAtRef = React.useRef(-Infinity);
  const narrationRef = React.useRef<CastNarrationSession | null>(null);
  const narrationAudioRef = React.useRef<HTMLAudioElement | null>(null);

  const [recorderState, setRecorderState] =
    React.useState<CastRecorderState>("idle");
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [script, setScript] = React.useState<CastScriptV1 | null>(null);
  const [isSaved, setIsSaved] = React.useState(true);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackSpeed, setPlaybackSpeed] =
    React.useState<typeof PLAYBACK_SPEEDS[number]>(1);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [pointerPosition, setPointerPosition] = React.useState<{
    x: number;
    y: number;
    visible: boolean;
  } | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [cloudState, setCloudState] = React.useState<
    "idle" | "saving" | "saved"
  >("idle");

  const [viewMode, setViewMode] = React.useState<PreviewViewMode>("fit");
  // ADR 0034 R5: off by default, remembered
  const [withNarration, setWithNarration] =
    React.useState(isNarrationPreferred);
  const [isNarrating, setIsNarrating] = React.useState(false);
  const [narrationPending, setNarrationPending] = React.useState(false);

  const player = React.useMemo(
    () => (script ? new CastPlayer(script) : null),
    [script],
  );
  const allRecordedElements = React.useMemo(
    () => player?.getAllElements() ?? [],
    [player],
  );

  const applyPlaybackSnapshot = React.useCallback(
    (snapshot: CastPlaybackSnapshot) => {
      const previewAPI = previewAPIRef.current;
      if (!previewAPI) {
        return;
      }
      // The preview editor's own canvas size; on phones it is smaller than
      // the container.
      const { width, height } = previewAPI.getAppState();
      const fit =
        viewMode === "fit"
          ? getFitViewport(allRecordedElements, width, height)
          : null;
      previewAPI.addFiles(Object.values(snapshot.files));
      previewAPI.updateScene({
        elements: snapshot.elements,
        appState: toPreviewAppState(
          fit ? { ...snapshot.appState, ...fit } : snapshot.appState,
        ),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      previewAPI.history.clear();

      if (!snapshot.pointer?.visible) {
        setPointerPosition(null);
        return;
      }
      const viewport = sceneCoordsToViewportCoords(
        {
          sceneX: snapshot.pointer.x,
          sceneY: snapshot.pointer.y,
        },
        previewAPI.getAppState(),
      );
      const containerRect =
        previewContainerRef.current?.getBoundingClientRect();
      setPointerPosition({
        x: viewport.x - (containerRect?.left ?? 0),
        y: viewport.y - (containerRect?.top ?? 0),
        visible: true,
      });
    },
    [allRecordedElements, viewMode],
  );

  const seek = React.useCallback(
    (timeMs: number) => {
      if (!player) {
        return;
      }
      const nextTime = Math.max(0, Math.min(timeMs, player.getDurationMs()));
      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
      applyPlaybackSnapshot(player.seek(nextTime));
    },
    [applyPlaybackSnapshot, player],
  );

  React.useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  React.useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const unsubscribeIncrement = excalidrawAPI.onIncrement((increment) => {
      if (recorderRef.current?.getState() === "recording") {
        const now = performance.now();
        if (
          increment.type === "ephemeral" &&
          now - lastEphemeralSceneAtRef.current < 50
        ) {
          return;
        }
        if (increment.type === "ephemeral") {
          lastEphemeralSceneAtRef.current = now;
        }
        recorderRef.current.recordScene(readSceneSnapshot(excalidrawAPI));
      }
    });
    const unsubscribeViewport = excalidrawAPI.onScrollChange(
      (scrollX, scrollY, zoom) => {
        recorderRef.current?.recordViewport({
          scrollX,
          scrollY,
          zoom: zoom.value,
        });
      },
    );
    const unsubscribePointer = subscribeCastPointerUpdate((update) => {
      if (recorderRef.current?.getState() !== "recording") {
        return;
      }
      lastPointerRef.current = update.pointer;
      recorderRef.current.recordPointer({
        ...update.pointer,
        visible: update.visible ?? true,
      });
    });

    return () => {
      unsubscribeIncrement();
      unsubscribeViewport();
      unsubscribePointer();
    };
  }, [excalidrawAPI]);

  React.useEffect(() => {
    if (recorderState !== "recording") {
      return;
    }
    const interval = window.setInterval(() => {
      setElapsedMs(recorderRef.current?.getElapsedMs() ?? 0);
    }, 100);
    return () => window.clearInterval(interval);
  }, [recorderState]);

  React.useEffect(() => {
    const hasUnsavedWork = !isSaved && (script || recorderState !== "idle");
    if (!hasUnsavedWork) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isSaved, recorderState, script]);

  // narration audio for the loaded script, followed by the replay clock
  const narration = script?.narration ?? null;
  React.useEffect(() => {
    if (!narration) {
      return;
    }
    const url = createNarrationURL(narration);
    const audio = new Audio(url);
    audio.preload = "auto";
    // 0.5×/2× speech stays at its natural pitch
    audio.preservesPitch = true;
    narrationAudioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (narrationAudioRef.current === audio) {
        narrationAudioRef.current = null;
      }
    };
  }, [narration]);

  const syncNarrationAudio = React.useCallback(
    (timeMs: number, playing: boolean) => {
      const audio = narrationAudioRef.current;
      if (audio && narration) {
        syncNarration(audio, narration, {
          timeMs,
          playing,
          speed: playbackSpeed,
        });
      }
    },
    [narration, playbackSpeed],
  );

  React.useEffect(() => {
    if (!isPlaying || !player) {
      syncNarrationAudio(currentTimeRef.current, false);
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    playbackAnchorRef.current = {
      at: currentTimeRef.current,
      startedAt: performance.now(),
    };
    const tick = (now: number) => {
      const nextTime =
        playbackAnchorRef.current.at +
        (now - playbackAnchorRef.current.startedAt) * playbackSpeed;
      if (nextTime >= player.getDurationMs()) {
        seek(player.getDurationMs());
        syncNarrationAudio(player.getDurationMs(), false);
        setIsPlaying(false);
        return;
      }
      seek(nextTime);
      syncNarrationAudio(nextTime, true);
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeed, player, seek, syncNarrationAudio]);

  React.useEffect(() => {
    if (script && previewAPIRef.current) {
      seek(currentTime);
    }
  }, [currentTime, script, seek]);

  // a narration still recording must give the microphone back
  React.useEffect(
    () => () => {
      narrationRef.current?.discard();
      narrationRef.current = null;
    },
    [],
  );

  // Re-fit when the preview resizes (window resize, phone rotation).
  React.useEffect(() => {
    const container = previewContainerRef.current;
    if (!script || viewMode !== "fit" || !container) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (previewAPIRef.current) {
        seek(currentTimeRef.current);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [script, seek, viewMode]);

  const startRecording = () => {
    if (!excalidrawAPI) {
      return;
    }
    const recorder = new CastRecorder({
      title: excalidrawAPI.getName() || t("labels.cast.title"),
      appVersion: getVersion(),
      locale: document.documentElement.lang || undefined,
    });
    recorder.start(readSceneSnapshot(excalidrawAPI));
    recorderRef.current = recorder;
    narrationRef.current?.discard();
    narrationRef.current = withNarration
      ? startNarration(recorder, excalidrawAPI)
      : null;
    setIsNarrating(!!narrationRef.current);
    setNarrationPending(false);
    setScript(null);
    setCurrentTime(0);
    setElapsedMs(0);
    setRecorderState("recording");
    setIsSaved(false);
    setCloudState("idle");
    setErrorMessage(null);
  };

  /** mic problems never stop the drawing from being recorded */
  const startNarration = (
    recorder: CastRecorder,
    api: ExcalidrawImperativeAPI,
  ) => {
    const notify = (message: string) =>
      api.setToast({ message, duration: 5000, closable: true });
    const session = startCastNarration({
      getScriptTime: () => recorder.getElapsedMs(),
      deviceId: EditorLocalStorage.get<string>(
        EDITOR_LS_KEYS.VOICE_INPUT_DEVICE,
      ),
      onFailure: () => {
        setIsNarrating(false);
        notify(t("labels.cast.narration.failed"));
      },
      onEnded: (reason) => {
        // keep what was recorded; it's attached when the Cast stops
        void session?.finish();
        setIsNarrating(false);
        notify(
          t(
            reason === "limit"
              ? "labels.cast.narration.limit"
              : "labels.cast.narration.interrupted",
          ),
        );
      },
    });
    if (!session) {
      notify(t("labels.cast.narration.busy"));
    }
    return session;
  };

  const pauseRecording = () => {
    narrationRef.current?.pause();
    recorderRef.current?.pause();
    setElapsedMs(recorderRef.current?.getElapsedMs() ?? elapsedMs);
    setRecorderState("paused");
  };

  const resumeRecording = () => {
    if (!excalidrawAPI) {
      return;
    }
    recorderRef.current?.resume(readSceneSnapshot(excalidrawAPI));
    narrationRef.current?.resume();
    setRecorderState("recording");
  };

  const stopRecording = () => {
    if (!excalidrawAPI || !recorderRef.current) {
      return;
    }
    const lastPointer = lastPointerRef.current;
    if (lastPointer) {
      recorderRef.current.recordPointer({ ...lastPointer, visible: false });
    }
    const nextScript = recorderRef.current.stop(
      readSceneSnapshot(excalidrawAPI),
    );
    setScript(nextScript);
    setElapsedMs(nextScript.durationMs);
    setRecorderState("stopped");
    setCurrentTime(0);
    setIsPlaying(false);
    setIsSaved(false);

    const narrationSession = narrationRef.current;
    narrationRef.current = null;
    setIsNarrating(false);
    if (narrationSession) {
      setNarrationPending(true);
      void narrationSession.finish().then((narration) => {
        setNarrationPending(false);
        if (!narration) {
          return;
        }
        setScript((current) =>
          current?.id === nextScript.id
            ? {
                ...current,
                narration: {
                  ...narration,
                  offsetMs: Math.min(narration.offsetMs, current.durationMs),
                },
              }
            : current,
        );
      });
    }
  };

  // The bar lives outside the canvas, so canvas pointer updates stop at its
  // edge; mark the pointer hidden instead of leaving it parked there.
  const hideRecordedPointer = () => {
    const lastPointer = lastPointerRef.current;
    if (lastPointer && recorderRef.current?.getState() === "recording") {
      recorderRef.current.recordPointer({ ...lastPointer, visible: false });
    }
  };

  const discardRecording = () => {
    narrationRef.current?.discard();
    narrationRef.current = null;
    setIsNarrating(false);
    setNarrationPending(false);
    recorderRef.current = null;
    setScript(null);
    setRecorderState("idle");
    setElapsedMs(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setIsSaved(true);
    setCloudState("idle");
    setPointerPosition(null);
  };

  const importScript = async (file: File) => {
    try {
      const nextScript = deserializeCastScript(await file.text());
      recorderRef.current = null;
      setScript(nextScript);
      setRecorderState("stopped");
      setElapsedMs(nextScript.durationMs);
      setCurrentTime(0);
      setIsPlaying(false);
      setIsSaved(true);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof UnsupportedCastVersionError
          ? t("labels.cast.unsupportedVersion")
          : t("labels.cast.invalidScript"),
      );
    }
  };

  const saveToCloud = async () => {
    if (!script || !activeCloudScene) {
      return;
    }
    const backend = getCloudBackend();
    if (
      !cloudAuth.isSignedIn ||
      !backend.capabilities.cast ||
      !backend.capabilities.assetStorage ||
      !backend.cast.isAvailable()
    ) {
      setErrorMessage(t("labels.cast.cloudUnavailable"));
      return;
    }
    setCloudState("saving");
    setErrorMessage(null);
    try {
      await saveCastScriptToCloud({
        backend,
        sceneId: activeCloudScene.id,
        script,
      });
      setCloudState("saved");
      setIsSaved(true);
    } catch (error) {
      console.error(error);
      setCloudState("idle");
      setErrorMessage(t("labels.cast.cloudError"));
    }
  };

  // While capturing, collapse to the floating bar so the board stays usable.
  // Shown even if the menu closed the dialog, so a recording can't run hidden.
  if (recorderState === "recording" || recorderState === "paused") {
    return (
      <CastRecordingBar
        state={recorderState}
        elapsed={formatTime(elapsedMs)}
        onPause={pauseRecording}
        onResume={resumeRecording}
        onStop={stopRecording}
        onPointerOver={hideRecordedPointer}
        narrating={isNarrating}
      />
    );
  }

  if (!open) {
    return null;
  }

  const cloudSaveAvailable = Boolean(
    script && activeCloudScene && cloudAuth.isSignedIn,
  );

  return (
    <Dialog
      className="CastDialog"
      title={t("labels.cast.title")}
      size="wide"
      autofocus={false}
      closeOnClickOutside={false}
      onCloseRequest={onClose}
    >
      <div className="CastDialog__body">
        <p className="CastDialog__description">
          {t("labels.cast.description")}
        </p>
        <div className="CastDialog__recordingBar">
          <span
            className={`CastDialog__status CastDialog__status--${recorderState}`}
            data-testid="cast-recorder-status"
          >
            {t(`labels.cast.status.${recorderState}`)} · {formatTime(elapsedMs)}
          </span>
          <div className="CastDialog__actions">
            <UiButton onClick={onClose}>{t("buttons.close")}</UiButton>
            <UiButton
              onClick={() => importInputRef.current?.click()}
              data-testid="cast-import"
            >
              {t("labels.cast.import")}
            </UiButton>
            <UiButton
              variant="primary"
              onClick={startRecording}
              disabled={!excalidrawAPI}
              data-testid="cast-start-recording"
            >
              {t("labels.cast.start")}
            </UiButton>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json,.calileon-cast.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void importScript(file);
                }
                event.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="CastDialog__narration">
          <label>
            <input
              type="checkbox"
              checked={withNarration}
              onChange={(event) => {
                setWithNarration(event.target.checked);
                setNarrationPreferred(event.target.checked);
              }}
              data-testid="cast-narration-toggle"
            />
            {t("labels.cast.narration.toggle")}
          </label>
          <p className="CastDialog__narrationHint">
            {t("labels.cast.narration.hint")}
          </p>
        </div>

        {errorMessage && <Callout tone="danger">{errorMessage}</Callout>}

        {script && player ? (
          <>
            <div className="CastDialog__previewHeader">
              <strong>{t("labels.cast.preview")}</strong>
              <SegmentedControl
                size="sm"
                label={t("labels.cast.view.label")}
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: "fit", label: t("labels.cast.view.fit") },
                  { value: "follow", label: t("labels.cast.view.follow") },
                ]}
              />
              {narrationPending ? (
                <Badge>{t("labels.cast.narration.processing")}</Badge>
              ) : (
                script.narration && (
                  <Badge tone="info">
                    {t("labels.cast.narration.included")}
                  </Badge>
                )
              )}
              <span className="CastDialog__previewTime">
                {formatTime(currentTime)} / {formatTime(script.durationMs)}
              </span>
            </div>
            <div className="CastDialog__preview" ref={previewContainerRef}>
              {/* Own API scope: otherwise this nested editor replaces the
                  app's editor API on mount and clears it on unmount. */}
              <ExcalidrawAPIProvider>
                <Excalidraw
                  key={script.id}
                  initialData={{
                    elements: script.initial.elements,
                    appState: toPreviewAppState(script.initial.appState),
                    files: script.initial.files,
                  }}
                  onExcalidrawAPI={(api) => {
                    previewAPIRef.current = api;
                    if (api) {
                      seek(currentTime);
                    }
                  }}
                  viewModeEnabled={true}
                  zenModeEnabled={true}
                  handleKeyboardGlobally={false}
                  detectScroll={false}
                  autoFocus={false}
                  isCollaborating={false}
                  langCode={langCode}
                  UIOptions={{
                    canvasActions: {
                      loadScene: false,
                      saveToActiveFile: false,
                      export: false,
                      clearCanvas: false,
                      toggleTheme: false,
                      changeViewBackgroundColor: false,
                    },
                  }}
                />
              </ExcalidrawAPIProvider>
              {pointerPosition?.visible && (
                <div
                  className="CastDialog__pointer"
                  data-testid="cast-playback-pointer"
                  aria-label={t("labels.cast.pointer")}
                  style={{
                    transform: `translate(${pointerPosition.x}px, ${pointerPosition.y}px)`,
                  }}
                />
              )}
            </div>
            <div className="CastDialog__playbackControls">
              <div className="CastDialog__actions">
                <UiButton
                  variant="primary"
                  onClick={() => {
                    if (currentTime >= script.durationMs) {
                      seek(0);
                    }
                    setIsPlaying((value) => !value);
                  }}
                  data-testid="cast-toggle-playback"
                >
                  {isPlaying ? t("labels.cast.pause") : t("labels.cast.play")}
                </UiButton>
                <UiButton
                  onClick={() => {
                    setIsPlaying(false);
                    seek(0);
                    syncNarrationAudio(0, false);
                  }}
                >
                  {t("labels.cast.restart")}
                </UiButton>
              </div>
              <SegmentedControl
                className="CastDialog__speed"
                size="sm"
                label={t("labels.cast.speed")}
                value={String(playbackSpeed)}
                onChange={(value) =>
                  setPlaybackSpeed(
                    Number(value) as typeof PLAYBACK_SPEEDS[number],
                  )
                }
                options={PLAYBACK_SPEEDS.map((speed) => ({
                  value: String(speed),
                  label: `${speed}×`,
                }))}
              />
            </div>
            <Range
              label={t("labels.cast.timeline")}
              value={Math.round(currentTime)}
              min={0}
              max={Math.max(1, script.durationMs)}
              step={50}
              minLabel="0:00"
              testId="cast-timeline"
              onChange={(value) => {
                setIsPlaying(false);
                seek(value);
                syncNarrationAudio(value, false);
              }}
            />
            <div className="CastDialog__footerActions">
              <UiButton
                variant="danger"
                className="CastDialog__discard"
                onClick={discardRecording}
                data-testid="cast-discard"
              >
                {t("labels.cast.discard")}
              </UiButton>
              <UiButton
                onClick={() => void saveToCloud()}
                disabled={
                  !cloudSaveAvailable ||
                  cloudState === "saving" ||
                  narrationPending
                }
                loading={cloudState === "saving"}
                title={
                  cloudSaveAvailable
                    ? undefined
                    : t("labels.cast.cloudUnavailable")
                }
                data-testid="cast-save-cloud"
              >
                {cloudState === "saving"
                  ? t("labels.cast.savingCloud")
                  : cloudState === "saved"
                  ? t("labels.cast.savedCloud")
                  : t("labels.cast.saveCloud")}
              </UiButton>
              <UiButton
                variant="primary"
                onClick={() => {
                  downloadScript(script);
                  setIsSaved(true);
                }}
                disabled={narrationPending}
                data-testid="cast-export"
              >
                {t("labels.cast.export")}
              </UiButton>
            </div>
          </>
        ) : (
          <div className="CastDialog__empty">{t("labels.cast.empty")}</div>
        )}
      </div>
    </Dialog>
  );
};
