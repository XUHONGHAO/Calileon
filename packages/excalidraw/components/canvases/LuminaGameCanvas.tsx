import { useEffect, useRef } from "react";

import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  buildLuminaGameState,
  getLuminaDarkRoomRenderModel,
  getLuminaLaserTrace,
  getLuminaShadowRenderModel,
} from "../../renderer/lumina/game";
import {
  getNewlyMatchedShadowTargetIds,
  renderLuminaGameEffects,
  shouldAnimateShadowMatch,
} from "../../renderer/lumina/gameRender";
import {
  clearLuminaGameSession,
  EMPTY_LUMINA_GAME_SESSION,
  updateDarkRoomSession,
} from "../../renderer/lumina/gameSession";
import { recordLuminaPerformanceSample } from "../../renderer/lumina/performance";
import { createLuminaRafScheduler } from "../../renderer/lumina/raf";

import type { LuminaRafScheduler } from "../../renderer/lumina/raf";

import type { AppState } from "../../types";

interface LuminaGameCanvasProps {
  appState: AppState;
  elements: readonly NonDeletedExcalidrawElement[];
  elementsMap: ElementsMap;
  scale: number;
}

/**
 * Screen-only Lumina game visualization layer. It sits above LightingCanvas so
 * laser colors do not pass through the lighting light-map's multiply blend.
 */
const LuminaGameCanvas = (props: LuminaGameCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const schedulerRef = useRef<LuminaRafScheduler | null>(null);
  const previousMatchedTargetIdsRef = useRef<Set<string>>(new Set());
  const previousDiscoveredTreasureIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    schedulerRef.current = createLuminaRafScheduler(
      window.requestAnimationFrame.bind(window),
      window.cancelAnimationFrame.bind(window),
    );
    return () => schedulerRef.current?.cancel();
  }, []);

  useEffect(() => {
    const mode = props.appState.luminaGameMode;
    return () => clearLuminaGameSession(mode);
  }, [props.appState.luminaGameMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }

    schedulerRef.current?.schedule((timestamp) => {
      const frameStartedAt = window.performance.now();

      const viewport = {
        scrollX: props.appState.scrollX,
        scrollY: props.appState.scrollY,
        zoom: props.appState.zoom.value,
        width: props.appState.width,
        height: props.appState.height,
        scale: props.scale,
      };
      const gameState = buildLuminaGameState(
        props.elements,
        props.elementsMap,
        {
          luminaEnabled: props.appState.luminaEnabled,
          luminaAmbient: props.appState.luminaAmbient,
          luminaCaustics: props.appState.luminaCaustics,
          luminaGameMode: props.appState.luminaGameMode,
        },
      );

      if (!gameState) {
        previousMatchedTargetIdsRef.current.clear();
        previousDiscoveredTreasureIdsRef.current.clear();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        recordLuminaPerformanceSample(
          "game",
          window.performance.now() - frameStartedAt,
        );
        return;
      }

      if (gameState.mode.style === "laser") {
        previousMatchedTargetIdsRef.current.clear();
        previousDiscoveredTreasureIdsRef.current.clear();
        const trace = getLuminaLaserTrace(gameState);
        renderLuminaGameEffects(
          ctx,
          { style: "laser", targets: gameState.targets, trace },
          viewport,
        );
        recordLuminaPerformanceSample(
          "game",
          window.performance.now() - frameStartedAt,
        );
        return;
      }

      if (gameState.mode.style === "shadow-reveal") {
        previousDiscoveredTreasureIdsRef.current.clear();
        const model = getLuminaShadowRenderModel(gameState);
        const isPlayMode = gameState.mode.phase === "play";
        const newlyMatchedTargetIds = isPlayMode
          ? getNewlyMatchedShadowTargetIds(
              previousMatchedTargetIdsRef.current,
              model.matchedShadowTargetIds,
            )
          : new Set<string>();
        previousMatchedTargetIdsRef.current = isPlayMode
          ? new Set(model.matchedShadowTargetIds)
          : new Set();

        const reduceMotion =
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
          false;
        const shouldPulse = shouldAnimateShadowMatch(
          gameState.mode.phase,
          newlyMatchedTargetIds.size,
          reduceMotion,
        );
        const pulseDuration = 520;

        const drawShadowFrame = (frameTimestamp: number) => {
          const drawStartedAt =
            frameTimestamp === timestamp
              ? frameStartedAt
              : window.performance.now();
          const pulseProgress = shouldPulse
            ? Math.min(1, (frameTimestamp - timestamp) / pulseDuration)
            : null;
          renderLuminaGameEffects(
            ctx,
            {
              style: "shadow-reveal",
              phase: gameState.mode.phase,
              model,
            },
            viewport,
            {
              pulseTargetIds: newlyMatchedTargetIds,
              pulseProgress,
            },
          );
          recordLuminaPerformanceSample(
            "game",
            window.performance.now() - drawStartedAt,
          );
          if (shouldPulse && pulseProgress != null && pulseProgress < 1) {
            schedulerRef.current?.schedule(drawShadowFrame);
          }
        };

        drawShadowFrame(timestamp);
        return;
      }

      if (gameState.mode.style === "dark-room") {
        previousMatchedTargetIdsRef.current.clear();
        const model = getLuminaDarkRoomRenderModel(gameState);
        const session =
          gameState.mode.phase === "play"
            ? updateDarkRoomSession(
                gameState.mode,
                model.revealedTreasureIds,
                model.requiredTreasureIds,
                model.stickyRevealedTreasureIds,
              )
            : EMPTY_LUMINA_GAME_SESSION;
        const newlyDiscoveredIds =
          gameState.mode.phase === "play"
            ? getNewlyMatchedShadowTargetIds(
                previousDiscoveredTreasureIdsRef.current,
                session.discoveredIds,
              )
            : new Set<string>();
        previousDiscoveredTreasureIdsRef.current =
          gameState.mode.phase === "play"
            ? new Set(session.discoveredIds)
            : new Set();
        const reduceMotion =
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
          false;
        const shouldPulse = shouldAnimateShadowMatch(
          gameState.mode.phase,
          newlyDiscoveredIds.size,
          reduceMotion,
        );
        const pulseDuration = 520;

        const drawDarkRoomFrame = (frameTimestamp: number) => {
          const drawStartedAt =
            frameTimestamp === timestamp
              ? frameStartedAt
              : window.performance.now();
          const pulseProgress = shouldPulse
            ? Math.min(1, (frameTimestamp - timestamp) / pulseDuration)
            : null;
          renderLuminaGameEffects(
            ctx,
            {
              style: "dark-room",
              phase: gameState.mode.phase,
              model,
              session,
            },
            viewport,
            {
              pulseTargetIds: newlyDiscoveredIds,
              pulseProgress,
            },
          );
          recordLuminaPerformanceSample(
            "game",
            window.performance.now() - drawStartedAt,
          );
          if (shouldPulse && pulseProgress != null && pulseProgress < 1) {
            schedulerRef.current?.schedule(drawDarkRoomFrame);
          }
        };

        drawDarkRoomFrame(timestamp);
        return;
      }

      previousMatchedTargetIdsRef.current.clear();
      previousDiscoveredTreasureIdsRef.current.clear();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      recordLuminaPerformanceSample(
        "game",
        window.performance.now() - frameStartedAt,
      );
    });
  });

  return (
    <canvas
      className="excalidraw__canvas"
      style={{
        width: props.appState.width,
        height: props.appState.height,
        pointerEvents: "none",
      }}
      width={props.appState.width * props.scale}
      height={props.appState.height * props.scale}
      ref={canvasRef}
    />
  );
};

export default LuminaGameCanvas;
