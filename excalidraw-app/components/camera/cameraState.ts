import { EDITOR_LS_KEYS } from "@excalidraw/common";
import { EditorLocalStorage } from "@excalidraw/excalidraw/data/EditorLocalStorage";
import { useSyncExternalStore } from "react";

// The "More tools" item unmounts as soon as the dropdown closes, so it only
// flips this flag; `CameraCaptureHost` reads it and owns the dialog (same
// pattern as labsDialogs).

let open = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export const openCameraCapture = () => {
  if (!open) {
    open = true;
    emit();
  }
};

export const closeCameraCapture = () => {
  if (open) {
    open = false;
    emit();
  }
};

export const isCameraCaptureOpen = () => open;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useCameraCaptureOpen = () =>
  useSyncExternalStore(subscribe, () => open);

export type CameraMode = "photo" | "video";
export const CAMERA_COUNTDOWNS = [0, 3, 5, 10] as const;
export type CameraCountdown = typeof CAMERA_COUNTDOWNS[number];

export type CameraPrefs = {
  mode: CameraMode;
  cameraId: string | null;
  withAudio: boolean;
  countdown: CameraCountdown;
};

export const CAMERA_PREFS_KEY = "calileon-camera-prefs";

/** sound is opt-in: a reference clip is usually about the motion (ADR 0035) */
export const DEFAULT_CAMERA_PREFS: CameraPrefs = {
  mode: "photo",
  cameraId: null,
  withAudio: false,
  countdown: 0,
};

export const loadCameraPrefs = (): CameraPrefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(CAMERA_PREFS_KEY) || "{}");
    return {
      mode: raw?.mode === "video" ? "video" : "photo",
      cameraId:
        typeof raw?.cameraId === "string" && raw.cameraId ? raw.cameraId : null,
      withAudio: raw?.withAudio === true,
      countdown: (CAMERA_COUNTDOWNS as readonly number[]).includes(
        raw?.countdown,
      )
        ? raw.countdown
        : 0,
    };
  } catch {
    return { ...DEFAULT_CAMERA_PREFS };
  }
};

export const saveCameraPrefs = (prefs: CameraPrefs) => {
  try {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
};

/** the microphone is shared with the voice tool's device choice */
export const loadMicDeviceId = () =>
  EditorLocalStorage.get<string>(EDITOR_LS_KEYS.VOICE_INPUT_DEVICE);

export const saveMicDeviceId = (deviceId: string | null) => {
  if (deviceId) {
    EditorLocalStorage.set(EDITOR_LS_KEYS.VOICE_INPUT_DEVICE, deviceId);
  } else {
    EditorLocalStorage.delete(EDITOR_LS_KEYS.VOICE_INPUT_DEVICE);
  }
};
