import { useEffect, useId, useState } from "react";

import { MASK_BRUSH_SIZE_LIMITS } from "../ai/maskCanvas";

import "./AIMaskEditingOverlay.scss";

export type AIMaskEditingTargetBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type AIMaskEditingOverlayProps = {
  targetImageId: string;
  targetBounds: AIMaskEditingTargetBounds | null;
  isErasing: boolean;
  brushSize: number;
  zoomValue: number;
  maskPreviewDataURL: string | null;
  onBrushSizeChange: (size: number) => void;
  onDone: () => void;
  onCancel: () => void;
};

const HIGHLIGHT_PADDING = 8;

export const AIMaskEditingOverlay = ({
  targetImageId,
  targetBounds,
  isErasing,
  brushSize,
  zoomValue,
  maskPreviewDataURL,
  onBrushSizeChange,
  onDone,
  onCancel,
}: AIMaskEditingOverlayProps) => {
  const maskId = `ai-mask-${useId().replace(/:/g, "")}`;
  const [cursorPosition, setCursorPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const paddedBounds = targetBounds
    ? {
        x: targetBounds.x - HIGHLIGHT_PADDING,
        y: targetBounds.y - HIGHLIGHT_PADDING,
        width: targetBounds.width + HIGHLIGHT_PADDING * 2,
        height: targetBounds.height + HIGHLIGHT_PADDING * 2,
      }
    : null;
  const cursorSize = Math.max(2, brushSize * zoomValue);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!targetBounds || isMaskEditingControlTarget(event.target)) {
        setCursorPosition(null);
        return;
      }

      const isWithinTarget =
        event.clientX >= targetBounds.x &&
        event.clientX <= targetBounds.x + targetBounds.width &&
        event.clientY >= targetBounds.y &&
        event.clientY <= targetBounds.y + targetBounds.height;

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

  return (
    <div className="AIMaskEditingOverlay" data-target-image-id={targetImageId}>
      <svg className="AIMaskEditingOverlay__backdrop" aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {paddedBounds && (
              <rect
                x={paddedBounds.x}
                y={paddedBounds.y}
                width={paddedBounds.width}
                height={paddedBounds.height}
                rx="10"
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
          <rect
            x={paddedBounds.x}
            y={paddedBounds.y}
            width={paddedBounds.width}
            height={paddedBounds.height}
            rx="10"
            className="AIMaskEditingOverlay__focusRing"
          />
        )}
      </svg>

      {targetBounds && maskPreviewDataURL && (
        <img
          className="AIMaskEditingOverlay__canvasMask"
          src={maskPreviewDataURL}
          alt=""
          aria-hidden="true"
          style={{
            left: targetBounds.x,
            top: targetBounds.y,
            width: targetBounds.width,
            height: targetBounds.height,
          }}
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

      <div className="AIMaskEditingOverlay__toolbar" role="status">
        <span>
          {isErasing
            ? "Erasing mask | Press E to draw"
            : "Drawing (white brush) | Press E to erase"}
        </span>
        <div className="AIMaskEditingOverlay__buttons">
          <button type="button" onClick={onDone}>
            Done
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div className="AIMaskEditingOverlay__brushToolbar">
        <label>
          <span>Brush size: {brushSize}px</span>
          <input
            type="range"
            min={MASK_BRUSH_SIZE_LIMITS.min}
            max={MASK_BRUSH_SIZE_LIMITS.max}
            value={brushSize}
            aria-label="Brush size"
            onChange={(event) =>
              onBrushSizeChange(Number(event.currentTarget.value))
            }
          />
        </label>
      </div>

      {maskPreviewDataURL && (
        <aside className="AIMaskEditingOverlay__preview">
          <div className="AIMaskEditingOverlay__previewTitle">Mask preview</div>
          <img src={maskPreviewDataURL} alt="Mask preview" />
        </aside>
      )}
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
