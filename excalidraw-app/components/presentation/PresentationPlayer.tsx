import clsx from "clsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { THEME, applyDarkModeFilter } from "@excalidraw/common";
import { CaptureUpdateAction, getSceneVersion } from "@excalidraw/element";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";

import type {
  ExcalidrawImperativeAPI,
  AppState,
} from "@excalidraw/excalidraw/types";

import {
  getFitZoom,
  getFrameScreenRect,
  getPresentationKeyAction,
  prefersReducedMotion,
  resetTimer,
  toggleTimer,
} from "../../presentation/playerHelpers";
import {
  dismissPresenterBlocked,
  forgetPresenterWindow,
  openPresenterView,
  stopPresentation,
  usePresentationSession,
} from "../../presentation/session";
import {
  getPlayableSlides,
  getPlayableStartIndex,
  getSlideTitle,
  getSlides,
} from "../../presentation/slides";
import { useSlideThumbnails } from "../../presentation/thumbnails";

import {
  exitIcon,
  laserIcon,
  nextIcon,
  presenterIcon,
  prevIcon,
} from "./icons";
import { PresenterView } from "./PresenterView";
import { PresenterWindow } from "./PresenterWindow";

import "./PresentationPlayer.scss";

import type {
  PresentationKeyAction,
  PresentationTimer,
} from "../../presentation/playerHelpers";
import type { PresentationSession } from "../../presentation/session";
import type { Slide } from "../../presentation/slides";

export const PRESENTING_BODY_CLASS = "calileon-presenting";

const TRANSITION_MS = 600;
const CONTROLS_IDLE_MS = 2500;
const STATUS_MS = 4000;
const NEXT_THUMBNAIL_WIDTH = 320;

type SavedState = Pick<
  AppState,
  | "viewModeEnabled"
  | "frameRendering"
  | "activeTool"
  | "scrollX"
  | "scrollY"
  | "zoom"
  | "openSidebar"
  | "selectedElementIds"
  | "selectedGroupIds"
>;

const saveState = (appState: AppState): SavedState => ({
  viewModeEnabled: appState.viewModeEnabled,
  frameRendering: appState.frameRendering,
  activeTool: appState.activeTool,
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
  zoom: appState.zoom,
  openSidebar: appState.openSidebar,
  selectedElementIds: appState.selectedElementIds,
  selectedGroupIds: appState.selectedGroupIds,
});

const isTransparent = (color: string) =>
  color === "transparent" ||
  color.length === 5 ||
  color.length === 9 ||
  /(hsla|rgba)\(/.test(color);

/** What the static canvas paints behind the scene (renderer/helpers.ts). */
const getCanvasColor = (appState: AppState) => {
  const color = isTransparent(appState.viewBackgroundColor)
    ? "#ffffff"
    : appState.viewBackgroundColor;
  return applyDarkModeFilter(color, appState.theme === THEME.DARK);
};

const readPlayable = (api: ExcalidrawImperativeAPI) =>
  getPlayableSlides(getSlides(api.getSceneElements()));

const getSlidesKey = (slides: readonly Slide[]) =>
  slides.map((slide) => slide.frame.id).join(",");

/**
 * Full-screen slideshow on top of the live editor canvas (ADR 0036 §3): view
 * mode, frame names and outlines off, a mask over everything outside the
 * current frame, camera moves by `scrollToContent`. Everything is restored on
 * exit. The packages are not modified.
 */
export const PresentationPlayer = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const session = usePresentationSession();
  if (!session || !excalidrawAPI) {
    return null;
  }
  return (
    <PlayerSession key={session.id} api={excalidrawAPI} session={session} />
  );
};

const PlayerSession = ({
  api,
  session,
}: {
  api: ExcalidrawImperativeAPI;
  session: PresentationSession;
}) => {
  // Captured during render, before any effect touches the state (and only
  // once even under StrictMode's double effects).
  const [saved] = useState(() => saveState(api.getAppState()));
  const [previousFocus] = useState(
    () => document.activeElement as HTMLElement | null,
  );
  const restoreFrameRef = useRef<number | null>(null);
  const [initial] = useState(() => {
    const all = getSlides(api.getSceneElements());
    const playable = getPlayableSlides(all);
    return {
      playable,
      index: Math.max(0, getPlayableStartIndex(all, session.startFrameId)),
    };
  });
  const [playable, setPlayable] = useState(initial.playable);
  const [index, setIndex] = useState(initial.index);
  const [sceneVersion, setSceneVersion] = useState(() =>
    getSceneVersion(api.getSceneElementsIncludingDeleted()),
  );
  const [laser, setLaser] = useState(false);
  const [idle, setIdle] = useState(false);
  const [status, setStatus] = useState("");
  const [timer, setTimer] = useState<PresentationTimer>(() => ({
    startedAt: Date.now(),
    pausedAt: null,
  }));
  const [canvasColor, setCanvasColor] = useState(() =>
    getCanvasColor(api.getAppState()),
  );
  const [theme, setTheme] = useState(() => api.getAppState().theme);

  const rootRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<SVGRectElement>(null);
  const holeRef = useRef<SVGRectElement>(null);
  const fromHoleRef = useRef<SVGRectElement>(null);
  const stateRef = useRef({ playable, index });
  stateRef.current = { playable, index };
  const transitionRef = useRef<{ fromId: string; until: number } | null>(null);
  const lastFitRef = useRef<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    viewWidth: number;
    viewHeight: number;
  } | null>(null);
  const maskId = `presentation-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const current = playable[index] as Slide | undefined;
  const next = playable[index + 1] as Slide | undefined;

  const showStatus = useCallback((message: string) => setStatus(message), []);
  useEffect(() => {
    if (!status) {
      return;
    }
    const timerId = window.setTimeout(() => setStatus(""), STATUS_MS);
    return () => window.clearTimeout(timerId);
  }, [status]);

  // ---------------------------------------------------------------- mask
  const drawMask = useCallback(() => {
    const appState = api.getAppState();
    const { playable, index } = stateRef.current;
    const outer = outerRef.current;
    const hole = holeRef.current;
    const fromHole = fromHoleRef.current;
    if (!outer || !hole || !fromHole) {
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    outer.setAttribute("width", String(width));
    outer.setAttribute("height", String(height));
    const setRect = (rect: SVGRectElement, slide: Slide | undefined) => {
      const r = slide
        ? getFrameScreenRect(slide.frame, appState)
        : { x: 0, y: 0, width: 0, height: 0 };
      rect.setAttribute("x", String(r.x));
      rect.setAttribute("y", String(r.y));
      rect.setAttribute("width", String(Math.max(0, r.width)));
      rect.setAttribute("height", String(Math.max(0, r.height)));
    };
    setRect(hole, playable[index]);
    const transition = transitionRef.current;
    const from =
      transition && transition.until > performance.now()
        ? playable.find((slide) => slide.frame.id === transition.fromId)
        : undefined;
    setRect(fromHole, from);
  }, [api]);

  // ------------------------------------------------------------- camera
  const fit = useCallback(
    (slide: Slide, animate: boolean) => {
      const appState = api.getAppState();
      const zoom = getFitZoom(slide.frame, appState);
      lastFitRef.current = {
        id: slide.frame.id,
        x: slide.frame.x,
        y: slide.frame.y,
        width: slide.frame.width,
        height: slide.frame.height,
        viewWidth: appState.width,
        viewHeight: appState.height,
      };
      const shouldAnimate = animate && !prefersReducedMotion();
      api.scrollToContent(slide.frame, {
        fitToViewport: true,
        viewportZoomFactor: 1,
        minZoom: zoom,
        maxZoom: zoom,
        animate: shouldAnimate,
        duration: TRANSITION_MS,
      });
    },
    [api],
  );

  const goTo = useCallback(
    (target: number) => {
      const { playable, index } = stateRef.current;
      if (!playable.length) {
        return;
      }
      const nextIndex = Math.max(0, Math.min(playable.length - 1, target));
      if (nextIndex === index) {
        return;
      }
      const from = playable[index];
      const to = playable[nextIndex];
      if (from && !prefersReducedMotion()) {
        transitionRef.current = {
          fromId: from.frame.id,
          until: performance.now() + TRANSITION_MS + 50,
        };
        window.setTimeout(drawMask, TRANSITION_MS + 80);
      } else {
        transitionRef.current = null;
      }
      stateRef.current = { playable, index: nextIndex };
      setIndex(nextIndex);
      fit(to, true);
      drawMask();
    },
    [drawMask, fit],
  );

  // ------------------------------------------------------- enter / exit
  useEffect(() => {
    // StrictMode re-runs this effect: drop the restore queued by the cleanup
    if (restoreFrameRef.current !== null) {
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    document.body.classList.add(PRESENTING_BODY_CLASS);
    api.updateScene({
      appState: {
        viewModeEnabled: true,
        openSidebar: null,
        selectedElementIds: {},
        selectedGroupIds: {},
        userToFollow: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.updateFrameRendering({ name: false, outline: false });
    rootRef.current?.focus({ preventScroll: true });

    return () => {
      document.body.classList.remove(PRESENTING_BODY_CLASS);
      if (api.isDestroyed) {
        return;
      }
      api.updateFrameRendering(saved.frameRendering);
      api.updateScene({
        appState: {
          viewModeEnabled: saved.viewModeEnabled,
          activeTool: saved.activeTool,
          scrollX: saved.scrollX,
          scrollY: saved.scrollY,
          zoom: saved.zoom,
          openSidebar: saved.openSidebar,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // The editor deselects everything in the update that follows a view
      // mode change. Wait until that change has landed, then one more frame,
      // before putting the selection back.
      let frames = 0;
      let landed = saved.viewModeEnabled;
      const restoreSelection = () => {
        restoreFrameRef.current = null;
        if (api.isDestroyed) {
          return;
        }
        if (!landed) {
          landed = !api.getAppState().viewModeEnabled;
          if (++frames < 60) {
            restoreFrameRef.current = requestAnimationFrame(restoreSelection);
          }
          return;
        }
        api.updateScene({
          appState: {
            selectedElementIds: saved.selectedElementIds,
            selectedGroupIds: saved.selectedGroupIds,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      };
      restoreFrameRef.current = requestAnimationFrame(restoreSelection);
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [api, saved, previousFocus]);

  useEffect(() => {
    if (!initial.playable.length) {
      stopPresentation();
      api.setToast({ message: t("ai.presentation.nothingToPlay") });
      return;
    }
    // first slide without animation, after the sidebar has closed
    const slide = initial.playable[initial.index];
    fit(slide, false);
    const frame = requestAnimationFrame(() => {
      fit(slide, false);
      drawMask();
    });
    return () => cancelAnimationFrame(frame);
  }, [api, drawMask, fit, initial]);

  // ---------------------------------------------------- scene / viewport
  useEffect(() => {
    const unsubscribeScroll = api.onScrollChange(() => drawMask());
    const unsubscribeChange = api.onChange((elements, appState) => {
      setCanvasColor(getCanvasColor(appState));
      setTheme(appState.theme);
      const version = getSceneVersion(elements);
      setSceneVersion((previous) =>
        previous === version ? previous : version,
      );

      const last = lastFitRef.current;
      const { playable, index } = stateRef.current;
      const currentSlide = playable[index];
      if (
        last &&
        currentSlide &&
        last.id === currentSlide.frame.id &&
        (last.viewWidth !== appState.width ||
          last.viewHeight !== appState.height)
      ) {
        // fullscreen entered / window resized
        fit(currentSlide, false);
      }
    });
    const onResize = () => drawMask();
    window.addEventListener("resize", onResize);
    return () => {
      unsubscribeScroll();
      unsubscribeChange();
      window.removeEventListener("resize", onResize);
    };
  }, [api, drawMask, fit]);

  // collaborators may add, delete, reorder, hide or move slides mid-show
  useEffect(() => {
    const nextPlayable = readPlayable(api);
    const { playable: previous, index: previousIndex } = stateRef.current;
    const currentId = previous[previousIndex]?.frame.id;
    if (!nextPlayable.length) {
      if (previous.length) {
        stopPresentation();
        api.setToast({ message: t("ai.presentation.allSlidesRemoved") });
      }
      return;
    }
    const keepIndex = nextPlayable.findIndex(
      (slide) => slide.frame.id === currentId,
    );
    const nextIndex =
      keepIndex !== -1
        ? keepIndex
        : Math.min(previousIndex, nextPlayable.length - 1);
    const changedList = getSlidesKey(nextPlayable) !== getSlidesKey(previous);
    const nextSlide = nextPlayable[nextIndex];
    const last = lastFitRef.current;
    const moved =
      !last ||
      last.id !== nextSlide.frame.id ||
      last.x !== nextSlide.frame.x ||
      last.y !== nextSlide.frame.y ||
      last.width !== nextSlide.frame.width ||
      last.height !== nextSlide.frame.height;

    stateRef.current = { playable: nextPlayable, index: nextIndex };
    setPlayable(nextPlayable);
    if (nextIndex !== previousIndex) {
      setIndex(nextIndex);
    }
    if (keepIndex === -1 && currentId) {
      showStatus(t("ai.presentation.slideRemoved"));
      transitionRef.current = null;
      fit(nextSlide, true);
    } else if (moved && last) {
      fit(nextSlide, false);
    }
    if (changedList || moved) {
      drawMask();
    }
  }, [api, drawMask, fit, sceneVersion, showStatus]);

  useEffect(() => {
    drawMask();
  }, [drawMask, index, playable]);

  // -------------------------------------------------------------- input
  const laserRef = useRef(false);
  const toggleLaser = useCallback(() => {
    const enabled = !laserRef.current;
    laserRef.current = enabled;
    api.setActiveTool({ type: enabled ? "laser" : "selection" });
    setLaser(enabled);
  }, [api]);

  const runAction = useCallback(
    (action: PresentationKeyAction) => {
      const { index, playable } = stateRef.current;
      switch (action) {
        case "next":
          return goTo(index + 1);
        case "prev":
          return goTo(index - 1);
        case "first":
          return goTo(0);
        case "last":
          return goTo(playable.length - 1);
        case "laser":
          return toggleLaser();
        case "exit":
          return stopPresentation();
      }
    },
    [goTo, toggleLaser],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const onButton =
        !!target?.closest?.("button") &&
        (event.key === "Enter" || event.key === " ");
      const action = onButton ? null : getPresentationKeyAction(event);
      if (action) {
        event.preventDefault();
        runAction(action);
      }
      return action;
    },
    [runAction],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleKey(event);
      // no editor shortcut runs during the show; browser shortcuts still do
      event.stopPropagation();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [handleKey]);

  useEffect(() => {
    if (!session.requestedFullscreen) {
      return;
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        stopPresentation();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [session.requestedFullscreen]);

  useEffect(() => {
    const onPageHide = () => stopPresentation();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // controls hide after a pause in pointer activity, unless hovered/focused
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsHoverRef = useRef(false);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      const focused = controlsRef.current?.contains(document.activeElement);
      if (!controlsHoverRef.current && !focused) {
        setIdle(true);
      }
    }, CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.clearTimeout(idleTimerRef.current);
    };
  }, [wake]);

  useEffect(() => {
    if (session.presenterBlocked) {
      showStatus(t("ai.presentation.presenterBlocked"));
      dismissPresenterBlocked();
    }
  }, [session.presenterBlocked, showStatus]);

  const pointerTypeRef = useRef("mouse");

  // ---------------------------------------------------- presenter view
  const presenterWindow = session.presenterWindow;
  const getThumbnail = useSlideThumbnails({
    slides: presenterWindow && next ? [next] : [],
    elements: api.getSceneElementsIncludingDeleted(),
    files: api.getFiles(),
    darkMode: theme === THEME.DARK,
    viewBackgroundColor: api.getAppState().viewBackgroundColor,
    width: NEXT_THUMBNAIL_WIDTH,
    sceneVersion,
  });
  const onPresenterKey = useCallback(
    (event: KeyboardEvent) => {
      handleKey(event);
    },
    [handleKey],
  );

  const total = playable.length;
  const title = current ? getSlideTitle(current) : "";

  return (
    <div
      ref={rootRef}
      className={clsx("PresentationPlayer", {
        "is-laser": laser,
        "is-idle": idle,
      })}
      role="region"
      aria-roledescription={t("ai.presentation.slideshow")}
      aria-label={t("ai.presentation.slideshow")}
      tabIndex={-1}
    >
      <svg className="PresentationPlayer__mask" aria-hidden="true">
        <defs>
          <mask id={maskId}>
            <rect ref={outerRef} x="0" y="0" fill="white" />
            <rect ref={holeRef} fill="black" />
            <rect ref={fromHoleRef} fill="black" />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          mask={`url(#${maskId})`}
          style={{ fill: canvasColor }}
        />
      </svg>

      <div
        className="PresentationPlayer__hitArea"
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType || "mouse";
        }}
        onClick={(event) => {
          if (event.button !== 0) {
            return;
          }
          if (pointerTypeRef.current === "touch") {
            const half = event.currentTarget.getBoundingClientRect().width / 2;
            goTo(index + (event.clientX < half ? -1 : 1));
            wake();
          } else {
            goTo(index + 1);
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div
        ref={controlsRef}
        className="PresentationPlayer__controls"
        onPointerEnter={() => {
          controlsHoverRef.current = true;
          wake();
        }}
        onPointerLeave={() => {
          controlsHoverRef.current = false;
          wake();
        }}
        onFocus={wake}
        onBlur={wake}
      >
        <button
          type="button"
          className="PresentationPlayer__control"
          aria-label={t("ai.presentation.prev")}
          title={t("ai.presentation.prev")}
          disabled={index === 0}
          onClick={() => goTo(index - 1)}
        >
          {prevIcon}
        </button>
        <span className="PresentationPlayer__counter">
          {t("ai.presentation.slideOf", { index: index + 1, total })}
        </span>
        <button
          type="button"
          className="PresentationPlayer__control"
          aria-label={t("ai.presentation.next")}
          title={t("ai.presentation.next")}
          disabled={index >= total - 1}
          onClick={() => goTo(index + 1)}
        >
          {nextIcon}
        </button>
        <span className="PresentationPlayer__divider" aria-hidden="true" />
        <button
          type="button"
          className="PresentationPlayer__control"
          aria-label={t("ai.presentation.laser")}
          title={`${t("ai.presentation.laser")} (L)`}
          aria-pressed={laser}
          onClick={toggleLaser}
        >
          {laserIcon}
        </button>
        <button
          type="button"
          className="PresentationPlayer__control"
          aria-label={t("ai.presentation.presenterView")}
          title={t("ai.presentation.presenterView")}
          aria-pressed={!!presenterWindow}
          onClick={openPresenterView}
        >
          {presenterIcon}
        </button>
        <button
          type="button"
          className="PresentationPlayer__control"
          aria-label={t("ai.presentation.exit")}
          title={`${t("ai.presentation.exit")} (Esc)`}
          onClick={stopPresentation}
        >
          {exitIcon}
        </button>
      </div>

      {status && (
        <div className="PresentationPlayer__status" role="status">
          {status}
        </div>
      )}
      <div className="visually-hidden" aria-live="polite">
        {current
          ? t("ai.presentation.announce", {
              index: index + 1,
              total,
              title,
            })
          : ""}
      </div>

      {presenterWindow && current && (
        <PresenterWindow
          popup={presenterWindow}
          title={`${t("ai.presentation.presenterView")} · ${title}`}
          lang={getLanguage().code}
          className={clsx("excalidraw", "PresenterWindowRoot", {
            "theme--dark": theme === THEME.DARK,
          })}
          onClosed={forgetPresenterWindow}
          onKeyDown={onPresenterKey}
        >
          <PresenterView
            index={index}
            total={total}
            title={title}
            notes={current.data.notes ?? ""}
            nextTitle={next ? getSlideTitle(next) : null}
            nextThumbnail={next ? getThumbnail(next.frame.id) : null}
            timer={timer}
            onPrev={() => goTo(index - 1)}
            onNext={() => goTo(index + 1)}
            onToggleTimer={() =>
              setTimer((value) => toggleTimer(value, Date.now()))
            }
            onResetTimer={() =>
              setTimer((value) => resetTimer(value, Date.now()))
            }
            onExit={stopPresentation}
          />
        </PresenterWindow>
      )}
    </div>
  );
};
