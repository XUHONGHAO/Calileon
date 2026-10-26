import { useEffect, useRef } from "react";

import { KEYS, sceneCoordsToViewportCoords } from "@excalidraw/common";

import type { ExcalidrawVideoElement } from "@excalidraw/element/types";

import { useExcalidrawAppState } from "../components/App";
import { t } from "../i18n";

import "./VideoOverlays.scss";

/**
 * A native <video> placed exactly over the playing video element; follows
 * scroll and zoom. The static canvas keeps drawing the poster underneath, so
 * it never re-renders per frame (ADR 0035 §6).
 */
export const VideoPlaybackOverlay = ({
  element,
  url,
  onClose,
  onError,
}: {
  element: ExcalidrawVideoElement;
  url: string;
  onClose: () => void;
  onError: () => void;
}) => {
  const appState = useExcalidrawAppState();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const zoom = appState.zoom.value;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.focus({ preventScroll: true });
    const result = video.play();
    // autoplay policies or an unsupported codec reject the promise
    result?.catch?.((error: any) => {
      if (error?.name !== "AbortError") {
        onError();
      }
    });
    // only when a new clip starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const { x, y } = sceneCoordsToViewportCoords(
    { sceneX: element.x, sceneY: element.y },
    appState,
  );

  return (
    <video
      ref={videoRef}
      className="excalidraw-video-playback"
      src={url}
      controls
      playsInline
      disablePictureInPicture
      controlsList="nodownload noremoteplayback noplaybackrate"
      muted={!element.hasAudio}
      aria-label={t("element.video")}
      style={{
        left: x - appState.offsetLeft,
        top: y - appState.offsetTop,
        width: element.width * zoom,
        height: element.height * zoom,
        opacity: element.opacity / 100,
        borderRadius:
          Math.min(8, Math.min(element.width, element.height) / 4) * zoom,
      }}
      onEnded={onClose}
      onError={onError}
      onKeyDown={(event) => {
        if (event.key === KEYS.ESCAPE) {
          event.stopPropagation();
          onClose();
        }
      }}
    />
  );
};
