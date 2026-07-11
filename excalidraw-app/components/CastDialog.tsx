import {
  CaptureUpdateAction,
  Excalidraw,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { Range } from "@excalidraw/excalidraw/components/Range";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { t } from "@excalidraw/excalidraw/i18n";
import { getVersion } from "@excalidraw/common";
import React from "react";

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
  deserializeCastScript,
  saveCastScriptToCloud,
  serializeCastScript,
  subscribeCastPointerUpdate,
} from "../cast";

import { getCloudBackend } from "../data/cloud";

import "./CastDialog.scss";

import type {
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

  const player = React.useMemo(
    () => (script ? new CastPlayer(script) : null),
    [script],
  );

  const applyPlaybackSnapshot = React.useCallback(
    (snapshot: CastPlaybackSnapshot) => {
      const previewAPI = previewAPIRef.current;
      if (!previewAPI) {
        return;
      }
      previewAPI.addFiles(Object.values(snapshot.files));
      previewAPI.updateScene({
        elements: snapshot.elements,
        appState: toPreviewAppState(snapshot.appState),
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
    [],
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

  React.useEffect(() => {
    if (!isPlaying || !player) {
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
        setIsPlaying(false);
        return;
      }
      seek(nextTime);
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying, playbackSpeed, player, seek]);

  React.useEffect(() => {
    if (script && previewAPIRef.current) {
      seek(currentTime);
    }
  }, [currentTime, script, seek]);

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
    setScript(null);
    setCurrentTime(0);
    setElapsedMs(0);
    setRecorderState("recording");
    setIsSaved(false);
    setCloudState("idle");
    setErrorMessage(null);
  };

  const pauseRecording = () => {
    recorderRef.current?.pause();
    setElapsedMs(recorderRef.current?.getElapsedMs() ?? elapsedMs);
    setRecorderState("paused");
  };

  const resumeRecording = () => {
    if (!excalidrawAPI) {
      return;
    }
    recorderRef.current?.resume(readSceneSnapshot(excalidrawAPI));
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
  };

  const discardRecording = () => {
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
            <Button onSelect={onClose}>{t("buttons.close")}</Button>
            {recorderState === "idle" || recorderState === "stopped" ? (
              <Button
                onSelect={startRecording}
                disabled={!excalidrawAPI}
                data-testid="cast-start-recording"
              >
                {t("labels.cast.start")}
              </Button>
            ) : recorderState === "recording" ? (
              <Button
                onSelect={pauseRecording}
                data-testid="cast-pause-recording"
              >
                {t("labels.cast.pause")}
              </Button>
            ) : (
              <Button
                onSelect={resumeRecording}
                data-testid="cast-resume-recording"
              >
                {t("labels.cast.resume")}
              </Button>
            )}
            {(recorderState === "recording" || recorderState === "paused") && (
              <Button
                onSelect={stopRecording}
                data-testid="cast-stop-recording"
              >
                {t("labels.cast.stop")}
              </Button>
            )}
            <Button
              onSelect={() => importInputRef.current?.click()}
              data-testid="cast-import"
            >
              {t("labels.cast.import")}
            </Button>
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

        {errorMessage && (
          <div className="CastDialog__error">{errorMessage}</div>
        )}

        {script && player ? (
          <>
            <div className="CastDialog__previewHeader">
              <strong>{t("labels.cast.preview")}</strong>
              <span>
                {formatTime(currentTime)} / {formatTime(script.durationMs)}
              </span>
            </div>
            <div className="CastDialog__preview" ref={previewContainerRef}>
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
                <Button
                  onSelect={() => {
                    if (currentTime >= script.durationMs) {
                      seek(0);
                    }
                    setIsPlaying((value) => !value);
                  }}
                  data-testid="cast-toggle-playback"
                >
                  {isPlaying ? t("labels.cast.pause") : t("labels.cast.play")}
                </Button>
                <Button
                  onSelect={() => {
                    setIsPlaying(false);
                    seek(0);
                  }}
                >
                  {t("labels.cast.restart")}
                </Button>
              </div>
              <div
                className="CastDialog__speed"
                aria-label={t("labels.cast.speed")}
              >
                {PLAYBACK_SPEEDS.map((speed) => (
                  <Button
                    key={speed}
                    onSelect={() => setPlaybackSpeed(speed)}
                    selected={playbackSpeed === speed}
                  >
                    {speed}×
                  </Button>
                ))}
              </div>
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
              }}
            />
            <div className="CastDialog__footerActions">
              <Button
                onSelect={() => {
                  downloadScript(script);
                  setIsSaved(true);
                }}
                data-testid="cast-export"
              >
                {t("labels.cast.export")}
              </Button>
              <Button
                onSelect={() => void saveToCloud()}
                disabled={!cloudSaveAvailable || cloudState === "saving"}
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
              </Button>
              <Button onSelect={discardRecording} data-testid="cast-discard">
                {t("labels.cast.discard")}
              </Button>
            </div>
          </>
        ) : (
          <div className="CastDialog__empty">{t("labels.cast.empty")}</div>
        )}
      </div>
    </Dialog>
  );
};
