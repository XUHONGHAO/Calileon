import { useEffect, useRef } from "react";

import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import {
  drawAudioContentOnCanvas,
  getAudioPlaybackDrawOps,
} from "@excalidraw/element";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { useExcalidrawAppState } from "../components/App";

import "./VoiceOverlays.scss";

import type { AudioPlayer, AudioPlaybackState } from "./player";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

/**
 * Draws pause glyph + progress above the playing bubble. Pointer events pass
 * through, so the canvas keeps handling clicks on the bubble.
 */
export const PlaybackOverlay = ({
  element,
  status,
  player,
}: {
  element: ExcalidrawAudioElement;
  status: AudioPlaybackState["status"];
  player: AudioPlayer;
}) => {
  const appState = useExcalidrawAppState();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoom = appState.zoom.value;
  const { theme, viewBackgroundColor } = appState;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(element.width * zoom * dpr);
    canvas.height = Math.ceil(element.height * zoom * dpr);
    const reducedMotion = prefersReducedMotion();
    let lastProgress = -1;
    const draw = () => {
      let progress = player.getProgress();
      if (reducedMotion) {
        // step instead of a continuous sweep
        progress = Math.floor(progress * 10) / 10;
      }
      if (progress === lastProgress) {
        return;
      }
      lastProgress = progress;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
      drawAudioContentOnCanvas(
        ctx,
        getAudioPlaybackDrawOps(element, theme, {
          status,
          progress,
          canvasBackgroundColor: viewBackgroundColor,
        }),
      );
    };
    draw();
    if (status !== "playing") {
      return;
    }
    if (reducedMotion) {
      const timer = setInterval(draw, 500);
      return () => clearInterval(timer);
    }
    let frame = requestAnimationFrame(function tick() {
      draw();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [element, status, zoom, theme, viewBackgroundColor, player]);

  const { x, y } = sceneCoordsToViewportCoords(
    { sceneX: element.x, sceneY: element.y },
    appState,
  );

  return (
    <canvas
      ref={canvasRef}
      className="excalidraw-voice-playback"
      aria-hidden="true"
      style={{
        left: x - appState.offsetLeft,
        top: y - appState.offsetTop,
        width: element.width * zoom,
        height: element.height * zoom,
        opacity: element.opacity / 100,
      }}
    />
  );
};
