import clsx from "clsx";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { VIDEO_RECORDING_MAX_DURATION } from "@excalidraw/common";
import { cameraIcon, videoIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import type { TranslationKeys } from "@excalidraw/excalidraw/i18n";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  AppDialog,
  Callout,
  DialogActions,
  Field,
  SegmentedControl,
  Select,
  StatusPill,
  UiButton,
  confirmAction,
} from "../ui";

import {
  CAMERA_COUNTDOWNS,
  loadCameraPrefs,
  loadMicDeviceId,
  saveCameraPrefs,
  saveMicDeviceId,
} from "./cameraState";
import {
  CameraFailure,
  capturePhoto,
  capturePoster,
  getRecordingProblem,
  getVideoDimensions,
  listMediaDevices,
  openCamera,
  startVideoRecording,
} from "./recorder";

import "./CameraCaptureDialog.scss";

import type { CameraCountdown, CameraMode, CameraPrefs } from "./cameraState";
import type {
  CameraEnvironment,
  CameraError,
  OpenCamera,
  VideoRecorderSession,
  VideoRecording,
} from "./recorder";

// ADR 0035 §5: capture a photo or a ≤30 s clip as an AI reference. The
// preview is mirrored like a mirror; what's saved is never mirrored.

type Take =
  | { kind: "photo"; file: File; url: string }
  | {
      kind: "video";
      recording: VideoRecording;
      url: string;
      poster: string | null;
      width: number;
      height: number;
    };

type Phase =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "countdown"; remaining: number; action: CameraMode }
  | { kind: "recording" }
  | { kind: "processing" }
  | { kind: "review"; take: Take }
  | { kind: "error"; reason: CameraError };

type Props = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  /** why recordings can't be added right now (collab, Vault, shares); photos still can */
  videoBlockedReason: string | null;
  onClose: () => void;
  /** test seam; production uses the browser's media APIs */
  env?: CameraEnvironment;
};

const POSTER_AT = 1000;

const ERROR_KEYS: Record<CameraError, TranslationKeys> = {
  unsupported: "camera.errors.unsupported",
  blocked: "camera.errors.blocked",
  permission: "camera.errors.permission",
  noDevice: "camera.errors.noDevice",
  busy: "camera.errors.busy",
  micBusy: "camera.errors.micBusy",
  micUnavailable: "camera.errors.micUnavailable",
  recorderUnsupported: "camera.errors.recorderUnsupported",
  cameraError: "camera.errors.cameraError",
};

const errorMessage = (error: unknown) =>
  t(ERROR_KEYS[error instanceof CameraFailure ? error.reason : "cameraError"]);

export const CameraCaptureDialog = ({
  excalidrawAPI,
  videoBlockedReason,
  onClose,
  env,
}: Props) => {
  const [prefs, setPrefsState] = useState<CameraPrefs>(loadCameraPrefs);
  const [micId, setMicId] = useState<string | null>(loadMicDeviceId);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [cameraEpoch, setCameraEpoch] = useState(0);
  const [activeCamera, setActiveCamera] = useState<{
    deviceId: string | null;
    mirrored: boolean;
  }>({ deviceId: null, mirrored: true });
  const [inserting, setInserting] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<OpenCamera | null>(null);
  const sessionRef = useRef<VideoRecorderSession | null>(null);
  const posterRef = useRef<string | null>(null);
  const tickRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const videoBlockedRef = useRef(videoBlockedReason);
  videoBlockedRef.current = videoBlockedReason;

  const setPrefs = useCallback((patch: Partial<CameraPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      saveCameraPrefs(next);
      return next;
    });
  }, []);

  // a blocked mode falls back to photos, except for a take already underway
  const isTakeUnderway =
    phase.kind === "recording" ||
    phase.kind === "processing" ||
    (phase.kind === "countdown" && phase.action === "video") ||
    (phase.kind === "review" && phase.take.kind === "video");
  const mode: CameraMode = isTakeUnderway
    ? "video"
    : phase.kind === "review"
    ? "photo"
    : videoBlockedReason
    ? "photo"
    : prefs.mode;

  const stopTick = () => {
    window.clearInterval(tickRef.current);
    tickRef.current = undefined;
  };

  const discardSession = () => {
    stopTick();
    sessionRef.current?.discard();
    sessionRef.current = null;
    posterRef.current = null;
  };

  const refreshDevices = useCallback(async () => {
    const [nextCameras, nextMics] = await Promise.all([
      listMediaDevices("videoinput", env),
      listMediaDevices("audioinput", env),
    ]);
    if (mountedRef.current) {
      setCameras(nextCameras);
      setMics(nextMics);
    }
  }, [env]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // the camera is only on while it's needed: not in review, not while hidden
  const wantCamera = !hidden && phase.kind !== "review";
  useEffect(() => {
    if (!wantCamera) {
      return;
    }
    let cancelled = false;
    let opened: OpenCamera | null = null;
    const video = videoRef.current;
    setPhase({ kind: "starting" });
    openCamera({
      deviceId: prefs.cameraId,
      env,
      onEnded: () => {
        if (!cancelled) {
          discardSession();
          setPhase({ kind: "error", reason: "cameraError" });
        }
      },
    }).then(
      (camera) => {
        if (cancelled) {
          camera.close();
          return;
        }
        opened = camera;
        cameraRef.current = camera;
        setActiveCamera({
          deviceId: camera.deviceId,
          mirrored: camera.facingMode !== "environment",
        });
        if (video) {
          video.srcObject = camera.stream;
          void video.play?.()?.catch(() => {});
        }
        setPhase({ kind: "live" });
        // ids and labels are only listed once a permission was granted
        void refreshDevices();
      },
      (error) => {
        if (!cancelled) {
          setPhase({
            kind: "error",
            reason:
              error instanceof CameraFailure ? error.reason : "cameraError",
          });
        }
      },
    );
    return () => {
      cancelled = true;
      discardSession();
      opened?.close();
      if (cameraRef.current === opened) {
        cameraRef.current = null;
      }
      if (video) {
        video.srcObject = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantCamera, prefs.cameraId, cameraEpoch, env, refreshDevices]);

  // a hidden page releases the camera; an unfinished take is dropped
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const kind = phaseRef.current.kind;
        if (kind === "recording" || kind === "countdown") {
          setNotice(t("camera.hiddenDiscarded"));
        }
        // the camera effect's cleanup drops the recording; a review is kept
        if (kind !== "review") {
          setPhase({ kind: "starting" });
        }
        setHidden(true);
      } else {
        setHidden(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // the object URL lives exactly as long as its take
  const reviewUrl = phase.kind === "review" ? phase.take.url : null;
  useEffect(() => {
    if (!reviewUrl) {
      return;
    }
    return () => URL.revokeObjectURL(reviewUrl);
  }, [reviewUrl]);

  useEffect(() => () => stopTick(), []);

  const takePhoto = async () => {
    const video = videoRef.current;
    const camera = cameraRef.current;
    if (!video || !camera) {
      return;
    }
    setNotice(null);
    setPhase({ kind: "processing" });
    const file = await capturePhoto(video);
    if (!mountedRef.current || cameraRef.current !== camera) {
      return;
    }
    if (!file) {
      setNotice(t("camera.errors.cameraError"));
      setPhase({ kind: "live" });
      return;
    }
    setPhase({
      kind: "review",
      take: { kind: "photo", file, url: URL.createObjectURL(file) },
    });
  };

  const finishRecording = async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    sessionRef.current = null;
    stopTick();
    const video = videoRef.current;
    const poster =
      posterRef.current ?? (video ? capturePoster(video) : null) ?? null;
    posterRef.current = null;
    const { width, height } = getVideoDimensions(
      video,
      cameraRef.current?.track ?? null,
    );
    setPhase({ kind: "processing" });
    let recording: VideoRecording;
    try {
      recording = await session.stop();
    } catch (error) {
      if (mountedRef.current) {
        setNotice(errorMessage(error));
        setPhase({ kind: "live" });
      }
      return;
    }
    if (!mountedRef.current) {
      return;
    }
    const problem = getRecordingProblem(recording);
    if (problem) {
      setNotice(
        problem.key === "tooLarge"
          ? t("camera.tooLarge", { size: problem.size })
          : t("camera.tooShort"),
      );
      setPhase({ kind: "live" });
      return;
    }
    setPhase({
      kind: "review",
      take: {
        kind: "video",
        recording,
        url: URL.createObjectURL(recording.blob),
        poster,
        width,
        height,
      },
    });
  };

  const finishRef = useRef(finishRecording);
  finishRef.current = finishRecording;

  const startRecording = async () => {
    const camera = cameraRef.current;
    if (!camera || sessionRef.current) {
      return;
    }
    setNotice(null);
    // waiting for the mic prompt; nothing else may start meanwhile
    setPhase({ kind: "processing" });
    let session: VideoRecorderSession;
    try {
      session = await startVideoRecording({
        camera,
        withAudio: prefs.withAudio,
        micDeviceId: micId,
        env,
        onAutoStop: () => void finishRef.current(),
        onInterrupted: () => void finishRef.current(),
      });
    } catch (error) {
      if (mountedRef.current && cameraRef.current === camera) {
        setNotice(errorMessage(error));
        setPhase({ kind: "live" });
      }
      return;
    }
    if (!mountedRef.current || cameraRef.current !== camera) {
      session.discard();
      return;
    }
    sessionRef.current = session;
    posterRef.current = null;
    setElapsed(0);
    setPhase({ kind: "recording" });
    tickRef.current = window.setInterval(() => {
      const ms = session.elapsed();
      setElapsed(ms);
      if (!posterRef.current && ms >= POSTER_AT && videoRef.current) {
        posterRef.current = capturePoster(videoRef.current);
      }
    }, 200);
  };

  const startAction = (action: CameraMode) => {
    if (prefs.countdown) {
      setNotice(null);
      setPhase({ kind: "countdown", remaining: prefs.countdown, action });
    } else if (action === "photo") {
      void takePhoto();
    } else {
      void startRecording();
    }
  };

  // countdown: one tick per second, then the chosen action
  const countdownKey =
    phase.kind === "countdown" ? `${phase.action}:${phase.remaining}` : null;
  useEffect(() => {
    if (phase.kind !== "countdown") {
      return;
    }
    const { remaining, action } = phase;
    const timer = window.setTimeout(() => {
      if (remaining > 1) {
        setPhase({ kind: "countdown", remaining: remaining - 1, action });
      } else if (action === "photo") {
        setPhase({ kind: "live" });
        void takePhoto();
      } else {
        setPhase({ kind: "live" });
        void startRecording();
      }
    }, 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdownKey]);

  const retake = () => {
    setNotice(null);
    setPhase({ kind: "starting" });
  };

  const retry = () => {
    setNotice(null);
    setPhase({ kind: "starting" });
    setCameraEpoch((epoch) => epoch + 1);
  };

  const insert = async () => {
    if (phase.kind !== "review" || inserting) {
      return;
    }
    const { take } = phase;
    if (take.kind === "video" && videoBlockedRef.current) {
      setNotice(videoBlockedRef.current);
      return;
    }
    setInserting(true);
    try {
      if (take.kind === "photo") {
        await excalidrawAPI.insertPhoto(take.file);
      } else {
        await excalidrawAPI.insertVideoRecording({
          blob: take.recording.blob,
          mimeType: take.recording.mimeType,
          duration: take.recording.duration,
          naturalWidth: take.width,
          naturalHeight: take.height,
          hasAudio: take.recording.hasAudio,
          poster: take.poster,
        });
      }
    } catch (error: any) {
      if (mountedRef.current) {
        setInserting(false);
        setNotice(error?.message || t("camera.insertError"));
      }
      return;
    }
    excalidrawAPI.setToast({
      message: t(
        take.kind === "photo" ? "camera.photoAdded" : "camera.videoAdded",
      ),
      duration: 3000,
      closable: true,
    });
    onClose();
  };

  const onBeforeClose = async () => {
    const kind = phaseRef.current.kind;
    if (kind !== "recording" && kind !== "review" && kind !== "processing") {
      return true;
    }
    return confirmAction(t("camera.discardMessage"), {
      title: t("camera.discardTitle"),
      confirmLabel: t("camera.discard"),
      cancelLabel: t("camera.cancel"),
      danger: true,
    });
  };

  const requestDismiss = async () => {
    if (!inserting && (await onBeforeClose())) {
      onClose();
    }
  };

  const onCameraChange = (deviceId: string) => {
    setNotice(null);
    setPrefs({ cameraId: deviceId || null });
  };

  const onMicChange = (deviceId: string) => {
    const next = deviceId || null;
    saveMicDeviceId(next);
    setMicId(next);
  };

  const canChangeSettings =
    phase.kind === "live" ||
    phase.kind === "starting" ||
    phase.kind === "error";
  const remainingSeconds = Math.max(
    0,
    Math.ceil((VIDEO_RECORDING_MAX_DURATION - elapsed) / 1000),
  );
  const cameraValue =
    activeCamera.deviceId &&
    cameras.some((device) => device.deviceId === activeCamera.deviceId)
      ? activeCamera.deviceId
      : prefs.cameraId ?? "";
  const micValue =
    micId && mics.some((device) => device.deviceId === micId) ? micId : "";
  const take = phase.kind === "review" ? phase.take : null;

  const primaryAction =
    mode === "photo" ? (
      <UiButton
        variant="primary"
        icon={cameraIcon}
        onClick={() => startAction("photo")}
        disabled={phase.kind !== "live"}
        loading={phase.kind === "processing"}
        data-testid="camera-take-photo"
      >
        {t("camera.takePhoto")}
      </UiButton>
    ) : (
      <UiButton
        variant="primary"
        icon={videoIcon}
        onClick={() => startAction("video")}
        disabled={phase.kind !== "live"}
        loading={phase.kind === "processing"}
        data-testid="camera-start-recording"
      >
        {t("camera.startRecording")}
      </UiButton>
    );

  return (
    <AppDialog
      className="CameraCaptureDialog"
      title={t("camera.title")}
      size="regular"
      onCloseRequest={onClose}
      onBeforeClose={onBeforeClose}
      busy={inserting}
      closeOnClickOutside={false}
    >
      <div className="CameraCaptureDialog__controls">
        <SegmentedControl<CameraMode>
          label={t("camera.mode")}
          value={mode}
          onChange={(next) => {
            if (canChangeSettings) {
              setNotice(null);
              setPrefs({ mode: next });
            }
          }}
          options={[
            {
              value: "photo",
              label: t("camera.photo"),
              disabled: !canChangeSettings,
            },
            {
              value: "video",
              label: t("camera.video"),
              disabled: !canChangeSettings || !!videoBlockedReason,
              title: videoBlockedReason ?? undefined,
            },
          ]}
        />
        <div className="CameraCaptureDialog__fields">
          <Field label={t("camera.camera")}>
            <Select
              value={cameraValue}
              onChange={(event) => onCameraChange(event.target.value)}
              disabled={!canChangeSettings}
              data-testid="camera-device-select"
            >
              <option value="">{t("camera.defaultCamera")}</option>
              {cameras.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${t("camera.camera")} ${index + 1}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("camera.countdown")}>
            <Select
              value={String(prefs.countdown)}
              onChange={(event) =>
                setPrefs({
                  countdown: Number(event.target.value) as CameraCountdown,
                })
              }
              disabled={!canChangeSettings}
              data-testid="camera-countdown-select"
            >
              {CAMERA_COUNTDOWNS.map((seconds) => (
                <option key={seconds} value={String(seconds)}>
                  {seconds
                    ? t("camera.countdownSeconds", { seconds })
                    : t("camera.countdownOff")}
                </option>
              ))}
            </Select>
          </Field>
          {mode === "video" && (
            <label className="CameraCaptureDialog__check">
              <input
                type="checkbox"
                checked={prefs.withAudio}
                onChange={(event) =>
                  setPrefs({ withAudio: event.target.checked })
                }
                disabled={!canChangeSettings}
                data-testid="camera-with-audio"
              />
              <span>{t("camera.withAudio")}</span>
            </label>
          )}
          {mode === "video" && prefs.withAudio && (
            <Field label={t("camera.microphone")}>
              <Select
                value={micValue}
                onChange={(event) => onMicChange(event.target.value)}
                disabled={!canChangeSettings}
                data-testid="camera-mic-select"
              >
                <option value="">{t("camera.defaultMicrophone")}</option>
                {mics.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `${t("camera.microphone")} ${index + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {videoBlockedReason && prefs.mode === "video" && !isTakeUnderway && (
          <p className="CameraCaptureDialog__hint" role="status">
            {videoBlockedReason}
          </p>
        )}
      </div>

      <div
        className={clsx("CameraCaptureDialog__stage", {
          "CameraCaptureDialog__stage--mirrored": activeCamera.mirrored,
        })}
      >
        <video
          ref={videoRef}
          className="CameraCaptureDialog__preview"
          aria-label={t("camera.preview")}
          autoPlay
          muted
          playsInline
          hidden={phase.kind === "review" || phase.kind === "error"}
          data-testid="camera-preview"
        />
        {take?.kind === "photo" && (
          <img
            className="CameraCaptureDialog__review"
            src={take.url}
            alt={t("camera.review")}
            data-testid="camera-review-photo"
          />
        )}
        {take?.kind === "video" && (
          <video
            className="CameraCaptureDialog__review"
            src={take.url}
            aria-label={t("camera.review")}
            controls
            playsInline
            disablePictureInPicture
            controlsList="nodownload noremoteplayback"
            muted={!take.recording.hasAudio}
            poster={take.poster ?? undefined}
            data-testid="camera-review-video"
          />
        )}
        {phase.kind === "starting" && (
          <div className="CameraCaptureDialog__overlay" role="status">
            {t("camera.requesting")}
          </div>
        )}
        {phase.kind === "countdown" && (
          <div
            className="CameraCaptureDialog__overlay CameraCaptureDialog__countdown"
            role="status"
            aria-label={t("camera.countingDown", {
              seconds: phase.remaining,
            })}
            data-testid="camera-countdown"
          >
            {phase.remaining}
          </div>
        )}
        {phase.kind === "recording" && (
          <div className="CameraCaptureDialog__recording">
            <StatusPill
              tone="danger"
              label={t("camera.recording")}
              detail={t("camera.remaining", { seconds: remainingSeconds })}
            />
            <div
              className="CameraCaptureDialog__progress"
              role="progressbar"
              aria-label={t("camera.recording")}
              aria-valuemin={0}
              aria-valuemax={VIDEO_RECORDING_MAX_DURATION / 1000}
              aria-valuenow={Math.floor(elapsed / 1000)}
            >
              <span
                style={{
                  width: `${Math.min(
                    100,
                    (elapsed / VIDEO_RECORDING_MAX_DURATION) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>
        )}
        {phase.kind === "error" && (
          <div className="CameraCaptureDialog__overlay">
            <Callout
              tone="danger"
              action={
                phase.reason !== "unsupported" &&
                phase.reason !== "blocked" && (
                  <UiButton size="sm" onClick={retry}>
                    {t("camera.retry")}
                  </UiButton>
                )
              }
            >
              {t(ERROR_KEYS[phase.reason])}
            </Callout>
          </div>
        )}
      </div>

      {take && activeCamera.mirrored && (
        <p className="CameraCaptureDialog__hint">{t("camera.mirrorHint")}</p>
      )}
      {notice && (
        <Callout tone="warning" className="CameraCaptureDialog__notice">
          {notice}
        </Callout>
      )}

      <DialogActions
        leading={
          <UiButton variant="ghost" onClick={() => void requestDismiss()}>
            {t("camera.cancel")}
          </UiButton>
        }
      >
        {phase.kind === "countdown" && (
          <UiButton onClick={() => setPhase({ kind: "live" })}>
            {t("camera.cancelCountdown")}
          </UiButton>
        )}
        {phase.kind === "recording" && (
          <UiButton
            variant="danger"
            onClick={() => void finishRecording()}
            data-testid="camera-stop-recording"
          >
            {t("camera.stopRecording")}
          </UiButton>
        )}
        {take && (
          <>
            <UiButton onClick={retake} disabled={inserting}>
              {t("camera.retake")}
            </UiButton>
            <UiButton
              variant="primary"
              onClick={() => void insert()}
              loading={inserting}
              data-testid="camera-insert"
            >
              {t("camera.insert")}
            </UiButton>
          </>
        )}
        {(phase.kind === "live" ||
          phase.kind === "starting" ||
          phase.kind === "processing") &&
          primaryAction}
      </DialogActions>
    </AppDialog>
  );
};
