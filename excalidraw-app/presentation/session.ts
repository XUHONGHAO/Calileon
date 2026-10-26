import { useSyncExternalStore } from "react";
import { exitFullScreen, isFullScreen } from "@excalidraw/common";

/**
 * One slideshow at a time per page. Module state (not jotai) so the same
 * controller works in the app and in the single-file runtime, which mounts the
 * editor without the app's jotai provider.
 *
 * `startPresentation` must run inside the user's click: fullscreen and
 * `window.open` both need the transient activation.
 */

export type PresentationSession = {
  /** increments per start so the player resets its state */
  id: number;
  /** slide to start from (frame id); null = first playable slide */
  startFrameId: string | null;
  /** we asked for fullscreen, so we leave it on exit */
  requestedFullscreen: boolean;
  /** our same-origin popup, or null when not open / blocked */
  presenterWindow: Window | null;
  /** the popup was requested but the browser refused it */
  presenterBlocked: boolean;
};

const PRESENTER_WINDOW_NAME = "calileon-presenter";
const PRESENTER_PREF_KEY = "calileon-presenter-view";

const listeners = new Set<() => void>();
let session: PresentationSession | null = null;
let nextId = 1;

const emit = () => listeners.forEach((listener) => listener());

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getPresentationSession = () => session;

export const usePresentationSession = () =>
  useSyncExternalStore(subscribe, getPresentationSession);

export const isPresenting = () => !!session;

/** Opens an empty same-origin popup; `null` when the browser blocks it. */
const openPresenterWindow = (): Window | null => {
  try {
    const popup = window.open(
      "",
      PRESENTER_WINDOW_NAME,
      "popup,width=960,height=640",
    );
    return popup && !popup.closed ? popup : null;
  } catch {
    return null;
  }
};

const requestFullscreen = () => {
  if (isFullScreen()) {
    return false;
  }
  try {
    const request = document.documentElement.requestFullscreen?.();
    // Refusal (e.g. an iframe without `allowfullscreen`) falls back to the
    // in-page overlay; it is not an error.
    request?.catch(() => {});
    return !!request;
  } catch {
    return false;
  }
};

export const startPresentation = (opts: {
  startFrameId?: string | null;
  presenterView?: boolean;
}) => {
  if (session) {
    return;
  }
  const requestedFullscreen = requestFullscreen();
  const presenterWindow = opts.presenterView ? openPresenterWindow() : null;
  session = {
    id: nextId++,
    startFrameId: opts.startFrameId ?? null,
    requestedFullscreen,
    presenterWindow,
    presenterBlocked: !!opts.presenterView && !presenterWindow,
  };
  emit();
};

/** Re-open (or open) the presenter view from inside a user gesture. */
export const openPresenterView = () => {
  if (!session) {
    return;
  }
  const current = session.presenterWindow;
  if (current && !current.closed) {
    current.focus();
    return;
  }
  const presenterWindow = openPresenterWindow();
  session = {
    ...session,
    presenterWindow,
    presenterBlocked: !presenterWindow,
  };
  emit();
};

/** The user closed the popup themselves: the slideshow carries on. */
export const forgetPresenterWindow = () => {
  if (!session || !session.presenterWindow) {
    return;
  }
  session = { ...session, presenterWindow: null, presenterBlocked: false };
  emit();
};

export const dismissPresenterBlocked = () => {
  if (session?.presenterBlocked) {
    session = { ...session, presenterBlocked: false };
    emit();
  }
};

export const stopPresentation = () => {
  if (!session) {
    return;
  }
  const { presenterWindow, requestedFullscreen } = session;
  session = null;
  try {
    if (presenterWindow && !presenterWindow.closed) {
      presenterWindow.close();
    }
  } catch {
    // a closed / navigated popup can throw on access
  }
  if (requestedFullscreen && isFullScreen()) {
    exitFullScreen().catch(() => {});
  }
  emit();
};

// ------------------------------------------------------------ preference
// "Also open presenter view" checkbox, remembered on this device.

const readPresenterPref = () => {
  try {
    return localStorage.getItem(PRESENTER_PREF_KEY) === "on";
  } catch {
    return false;
  }
};
let presenterPref = readPresenterPref();

export const setPresenterViewPreference = (next: boolean) => {
  presenterPref = next;
  try {
    localStorage.setItem(PRESENTER_PREF_KEY, next ? "on" : "off");
  } catch {
    // storage unavailable: keep the in-memory choice for this session
  }
  emit();
};

export const usePresenterViewPreference = () =>
  useSyncExternalStore(subscribe, () => presenterPref);

export const getPresenterViewPreference = () => presenterPref;
