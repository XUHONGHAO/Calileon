import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  EraserIcon,
  FreedrawIcon,
  RedoIcon,
  UndoIcon,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import { getShortcutKey } from "@excalidraw/excalidraw/shortcut";

import { MASK_BRUSH_SIZE_LIMITS } from "../ai/maskCanvas";
import {
  expandMaskViewportGeometry,
  getMaskViewportBoxStyle,
  isPointInMaskViewportGeometry,
} from "../ai/maskViewportGeometry";

import { UiButton } from "./ui";

import "./AIMaskEditingOverlay.scss";

import type { MaskViewportGeometry } from "../ai/maskViewportGeometry";

export type AIMaskEditingTargetBounds = MaskViewportGeometry;

type AIMaskEditingOverlayProps = {
  targetImageId: string;
  targetBounds: AIMaskEditingTargetBounds | null;
  isErasing: boolean;
  brushSize: number;
  zoomValue: number;
  maskPreviewDataURL: string | null;
  isDonePending: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  theme?: "light" | "dark";
  onBrushSizeChange: (size: number) => void;
  /** Brush/eraser toggle; the `E` shortcut stays as well. */
  onErasingChange?: (isErasing: boolean) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  onMaskPointerDown: (clientX: number, clientY: number) => void;
  onMaskPointerMove: (clientX: number, clientY: number) => void;
  onMaskPointerUp: () => void;
};

const HIGHLIGHT_PADDING = 8;

export const AIMaskEditingOverlay = ({
  targetImageId,
  targetBounds,
  isErasing,
  brushSize,
  zoomValue,
  maskPreviewDataURL,
  isDonePending,
  canUndo = false,
  canRedo = false,
  theme = "light",
  onBrushSizeChange,
  onErasingChange,
  onUndo,
  onRedo,
  onDone,
  onCancel,
  onMaskPointerDown,
  onMaskPointerMove,
  onMaskPointerUp,
}: AIMaskEditingOverlayProps) => {
  const maskId = `ai-mask-${useId().replace(/:/g, "")}`;
  const [cursorPosition, setCursorPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const paddedBounds = targetBounds
    ? expandMaskViewportGeometry(targetBounds, HIGHLIGHT_PADDING)
    : null;
  const cursorSize = Math.max(2, brushSize * zoomValue);
  const finishActivePointer = useCallback(
    (pointerId?: number) => {
      if (
        activePointerIdRef.current === null ||
        (pointerId !== undefined && activePointerIdRef.current !== pointerId)
      ) {
        return;
      }

      activePointerIdRef.current = null;
      onMaskPointerUp();
    },
    [onMaskPointerUp],
  );

  // Start on the overlay itself, not on "Done": Space (held to pan in the
  // editor) or Enter must not submit the mask the moment editing opens.
  // Tab then walks into the toolbars.
  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!targetBounds || isMaskEditingControlTarget(event.target)) {
        setCursorPosition(null);
        return;
      }

      const isWithinTarget = isPointInMaskViewportGeometry(targetBounds, [
        event.clientX,
        event.clientY,
      ]);

      setCursorPosition(
        isWithinTarget ? { x: event.clientX, y: event.clientY } : null,
      );
    };

    const handlePointerLeave = () => {
      setCursorPosition(null);
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerleave", handlePointerLeave, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerleave", handlePointerLeave, true);
    };
  }, [targetBounds]);

  useEffect(() => {
    const handleWindowPointerUp = (event: PointerEvent) => {
      finishActivePointer(event.pointerId);
    };
    const handleWindowBlur = () => {
      finishActivePointer();
    };

    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerUp, true);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [finishActivePointer]);

  return (
    <div
      ref={overlayRef}
      className="AIMaskEditingOverlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("ai.workbench.maskEditor.drawing")}
      tabIndex={-1}
      data-target-image-id={targetImageId}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <svg className="AIMaskEditingOverlay__backdrop" aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {paddedBounds && (
              <polygon
                points={toPolygonPoints(paddedBounds.corners)}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          className="AIMaskEditingOverlay__scrim"
          mask={`url(#${maskId})`}
        />
        {paddedBounds && (
          <polygon
            points={toPolygonPoints(paddedBounds.corners)}
            className="AIMaskEditingOverlay__focusRing"
          />
        )}
      </svg>

      {targetBounds && (
        <div
          className="AIMaskEditingOverlay__drawingSurface"
          data-testid="mask-drawing-surface"
          style={getMaskViewportBoxStyle(targetBounds)}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              isDonePending ||
              activePointerIdRef.current !== null
            ) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            activePointerIdRef.current = event.pointerId;
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              // Pointer capture polyfills may reject synthetic pointer ids.
            }
            onMaskPointerDown(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (activePointerIdRef.current !== event.pointerId) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            onMaskPointerMove(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            if (activePointerIdRef.current !== event.pointerId) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            finishActivePointer(event.pointerId);
          }}
          onPointerCancel={(event) => {
            if (activePointerIdRef.current !== event.pointerId) {
              return;
            }

            finishActivePointer(event.pointerId);
          }}
          onLostPointerCapture={(event) => {
            finishActivePointer(event.pointerId);
          }}
        />
      )}

      {targetBounds && maskPreviewDataURL && (
        <img
          className="AIMaskEditingOverlay__canvasMask"
          src={maskPreviewDataURL}
          alt=""
          aria-hidden="true"
          style={getMaskViewportBoxStyle(targetBounds)}
        />
      )}

      {cursorPosition && (
        <div
          className={
            isErasing
              ? "AIMaskEditingOverlay__brushCursor is-erasing"
              : "AIMaskEditingOverlay__brushCursor"
          }
          style={{
            left: cursorPosition.x,
            top: cursorPosition.y,
            width: cursorSize,
            height: cursorSize,
          }}
        />
      )}

      {/* The overlay mounts outside the editor root; this scope gives the
          floating chrome the editor's theme tokens and UiButton styles. */}
      <div
        className={`excalidraw theme--${theme} AIMaskEditingOverlay__chrome`}
      >
        <div className="AIMaskEditingOverlay__toolbar" role="toolbar">
          <span aria-live="polite">
            {isErasing
              ? t("ai.workbench.maskEditor.erasing")
              : t("ai.workbench.maskEditor.drawing")}
          </span>
          <div className="AIMaskEditingOverlay__buttons">
            <UiButton
              variant="primary"
              loading={isDonePending}
              onClick={onDone}
            >
              {t("ai.workbench.maskEditor.done")}
            </UiButton>
            {/* Stays enabled while "Done" exports: cancelling aborts it,
                exactly like Escape. */}
            <UiButton onClick={onCancel}>
              {t("ai.workbench.maskEditor.cancel")}
            </UiButton>
          </div>
        </div>

        {/* Phones stack the preview on top of the brush toolbar here, so a
            taller toolbar can never slide under the preview. */}
        <div className="AIMaskEditingOverlay__bottomStack">
          {maskPreviewDataURL && (
            <aside className="AIMaskEditingOverlay__preview">
              <div className="AIMaskEditingOverlay__previewTitle">
                {t("ai.workbench.maskEditor.preview")}
              </div>
              <img
                src={maskPreviewDataURL}
                alt={t("ai.workbench.maskEditor.preview")}
              />
            </aside>
          )}

          <div className="AIMaskEditingOverlay__brushToolbar">
            <div className="AIMaskEditingOverlay__toolRow">
              <div
                className="AIMaskEditingOverlay__tools"
                role="group"
                aria-label={t("ai.workbench.maskEditor.tools")}
              >
                <UiButton
                  size="sm"
                  variant="ghost"
                  icon={FreedrawIcon}
                  className="AIMaskEditingOverlay__tool"
                  aria-pressed={!isErasing}
                  title={t("ai.workbench.maskEditor.toolShortcut")}
                  disabled={isDonePending}
                  onClick={() => onErasingChange?.(false)}
                >
                  {t("ai.workbench.maskEditor.brush")}
                </UiButton>
                <UiButton
                  size="sm"
                  variant="ghost"
                  icon={EraserIcon}
                  className="AIMaskEditingOverlay__tool"
                  aria-pressed={isErasing}
                  title={t("ai.workbench.maskEditor.toolShortcut")}
                  disabled={isDonePending}
                  onClick={() => onErasingChange?.(true)}
                >
                  {t("ai.workbench.maskEditor.eraser")}
                </UiButton>
              </div>
              <div className="AIMaskEditingOverlay__history">
                <UiButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={UndoIcon}
                  aria-label={t("ai.workbench.maskEditor.undo")}
                  title={`${t(
                    "ai.workbench.maskEditor.undo",
                  )} (${getShortcutKey("CtrlOrCmd+Z")})`}
                  disabled={!canUndo || isDonePending}
                  onClick={onUndo}
                />
                <UiButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={RedoIcon}
                  aria-label={t("ai.workbench.maskEditor.redo")}
                  title={`${t(
                    "ai.workbench.maskEditor.redo",
                  )} (${getShortcutKey("CtrlOrCmd+Y")})`}
                  disabled={!canRedo || isDonePending}
                  onClick={onRedo}
                />
              </div>
            </div>
            <label>
              <span>
                {t("ai.workbench.maskEditor.brushSize", { size: brushSize })}
              </span>
              <input
                type="range"
                min={MASK_BRUSH_SIZE_LIMITS.min}
                max={MASK_BRUSH_SIZE_LIMITS.max}
                value={brushSize}
                aria-label={t("ai.workbench.maskEditor.brushSizeLabel")}
                onChange={(event) =>
                  onBrushSizeChange(Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

const isMaskEditingControlTarget = (target: EventTarget | null) => {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      ".AIMaskEditingOverlay__toolbar, .AIMaskEditingOverlay__brushToolbar, .AIMaskEditingOverlay__preview",
    )
  );
};

const toPolygonPoints = (corners: MaskViewportGeometry["corners"]) =>
  corners.map(([x, y]) => `${x},${y}`).join(" ");
