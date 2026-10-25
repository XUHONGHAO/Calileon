import { useEffect, useRef } from "react";

import { THEME } from "@excalidraw/common";
import {
  drawAudioContentOnCanvas,
  getAudioAvatarDrawOps,
} from "@excalidraw/element";

import type { AudioAvatar as AudioAvatarData } from "@excalidraw/element/types";

import type { AppState } from "../types";

/**
 * The voice-message avatar (ADR 0034 §6) outside the canvas, e.g. for the
 * account settings preview. Draws with the same ops as the bubble so the two
 * can't drift apart. Takes `{ color, glyph }` only, never account data.
 */
export const AudioAvatar = ({
  avatar,
  size = 48,
  theme = THEME.LIGHT,
  label,
}: {
  avatar: AudioAvatarData;
  /** outer diameter in CSS px */
  size?: number;
  theme?: AppState["theme"];
  label?: string;
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    const half = size / 2;
    // leave room for the ring's stroke
    const r = half / (1 + 1 / 15);
    drawAudioContentOnCanvas(
      context,
      getAudioAvatarDrawOps(avatar, theme, { cx: half, cy: half, r }),
    );
  }, [avatar, size, theme]);

  return (
    <canvas
      ref={ref}
      className="excalidraw-audio-avatar"
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
};
