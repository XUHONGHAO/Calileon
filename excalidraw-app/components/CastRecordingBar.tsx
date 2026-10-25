import { createPortal } from "react-dom";
import { microphoneIcon } from "@excalidraw/excalidraw/components/icons";
import { useCreatePortalContainer } from "@excalidraw/excalidraw/hooks/useCreatePortalContainer";
import { t } from "@excalidraw/excalidraw/i18n";
import React from "react";

import { UiButton } from "./ui";

/**
 * Compact floating control shown instead of the Cast dialog while recording,
 * so the board stays usable. Cast records scene/viewport/pointer data rather
 * than pixels, so this bar never appears in the recording; `onPointerOver`
 * lets the caller hide the recorded pointer while the user reaches for it.
 */
export const CastRecordingBar = ({
  state,
  elapsed,
  onPause,
  onResume,
  onStop,
  onPointerOver,
  narrating = false,
}: {
  state: "recording" | "paused";
  elapsed: string;
  /** the microphone is being recorded too (ADR 0034 R5) */
  narrating?: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onPointerOver: () => void;
}) => {
  const container = useCreatePortalContainer({
    className: "CastRecordingBar-container",
  });

  if (!container) {
    return null;
  }

  return createPortal(
    <div
      className={`CastRecordingBar CastRecordingBar--${state}`}
      role="region"
      aria-label={t("labels.cast.title")}
      data-testid="cast-recording-bar"
      onPointerEnter={onPointerOver}
    >
      <span className="CastRecordingBar__status">
        <span className="CastRecordingBar__dot" aria-hidden="true" />
        <span className="CastRecordingBar__label">
          {t(`labels.cast.status.${state}`)}
        </span>
        <span className="CastRecordingBar__time">{elapsed}</span>
        {narrating && (
          <span
            className="CastRecordingBar__mic"
            role="img"
            aria-label={t("labels.cast.narration.recording")}
            title={t("labels.cast.narration.recording")}
            data-testid="cast-narration-indicator"
          >
            {microphoneIcon}
          </span>
        )}
      </span>
      {state === "recording" ? (
        <UiButton
          size="sm"
          onClick={onPause}
          data-testid="cast-pause-recording"
        >
          {t("labels.cast.pause")}
        </UiButton>
      ) : (
        <UiButton
          size="sm"
          onClick={onResume}
          data-testid="cast-resume-recording"
        >
          {t("labels.cast.resume")}
        </UiButton>
      )}
      <UiButton
        size="sm"
        variant="danger"
        onClick={onStop}
        data-testid="cast-stop-recording"
      >
        {t("labels.cast.stop")}
      </UiButton>
    </div>,
    container,
  );
};
