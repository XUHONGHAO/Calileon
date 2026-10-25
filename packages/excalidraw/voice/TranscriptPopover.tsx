import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { KEYS, sceneCoordsToViewportCoords } from "@excalidraw/common";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { t } from "../i18n";
import { useExcalidrawAppState } from "../components/App";
import { CloseIcon } from "../components/icons";

import "./VoiceOverlays.scss";

const POPOVER_WIDTH = 320;
const GAP = 8;

/**
 * Full transcript of a voice bubble, opened from its "文" badge (ADR 0034 §5).
 * Local only: nothing about it is synced or stored.
 */
export const TranscriptPopover = ({
  element,
  canInsert,
  onInsert,
  onClose,
}: {
  element: ExcalidrawAudioElement;
  canInsert: boolean;
  onInsert: (element: ExcalidrawAudioElement) => void;
  onClose: () => void;
}) => {
  const appState = useExcalidrawAppState();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    setHeight(rootRef.current?.offsetHeight ?? 0);
  }, [element.transcript?.text]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [element.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === KEYS.ESCAPE) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  const transcript = element.transcript;
  if (!transcript) {
    return null;
  }

  const below = sceneCoordsToViewportCoords(
    { sceneX: element.x, sceneY: element.y + element.height },
    appState,
  );
  const above = sceneCoordsToViewportCoords(
    { sceneX: element.x, sceneY: element.y },
    appState,
  );
  const left = Math.max(
    GAP,
    Math.min(
      below.x - appState.offsetLeft,
      appState.width - POPOVER_WIDTH - GAP,
    ),
  );
  const belowTop = below.y - appState.offsetTop + GAP;
  // flip above the bubble when there's no room underneath
  const top =
    belowTop + height > appState.height - GAP
      ? Math.max(GAP, above.y - appState.offsetTop - GAP - height)
      : belowTop;

  return (
    <div
      ref={rootRef}
      className="excalidraw-voice-transcript"
      style={{ left, top, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label={t("voice.transcript.title")}
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="excalidraw-voice-transcript__header">
        <span className="excalidraw-voice-transcript__title">
          {t("voice.transcript.title")}
        </span>
        <button
          type="button"
          className="excalidraw-voice-recorder__icon-button"
          title={t("buttons.close")}
          aria-label={t("buttons.close")}
          onClick={onClose}
        >
          {CloseIcon}
        </button>
      </div>
      <p className="excalidraw-voice-transcript__text" lang={transcript.lang}>
        {transcript.text}
      </p>
      {canInsert && (
        <div className="excalidraw-voice-transcript__actions">
          <button
            type="button"
            className="excalidraw-voice-recorder__button excalidraw-voice-recorder__button--primary"
            onClick={() => onInsert(element)}
          >
            {t("voice.transcript.insertAsText")}
          </button>
        </div>
      )}
    </div>
  );
};
