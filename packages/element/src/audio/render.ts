import {
  AUDIO_AVATAR_RING_COLOR,
  SVG_NS,
  THEME,
  applyDarkModeFilter,
  assertNever,
} from "@excalidraw/common";

import type { AppState } from "@excalidraw/excalidraw/types";

import { formatAudioDuration, getAudioAvatar } from "./helpers";

import type { AudioAvatar, ExcalidrawAudioElement } from "../types";

// Local layout of the bubble (element origin at top-left, angle always 0):
//   ( avatar )<| [ ▶  ▍▌▍▍▌▍▌▍▍   12″  (文) ]
const AVATAR_CX = 18;
const AVATAR_R = 15;
const RING_WIDTH = 2;
// transparent gap between the ring and the colored disc inside it
const AVATAR_GAP = 2;
const AVATAR_DISC_R = AVATAR_R - RING_WIDTH / 2 - AVATAR_GAP;
const BODY_X = 46;
const BODY_Y = 4;
const BODY_RADIUS = 12;
const TAIL_TIP_X = 39;
const TAIL_HALF = 6;
const PLAY_CX = BODY_X + 18;
const PLAY_ZONE_END = BODY_X + 36;
const WAVE_START = BODY_X + 34;
const BAR_WIDTH = 2;
const BAR_STEP = 4;
const DURATION_WIDTH = 34;
const BADGE_R = 9;
const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";

export type AudioElementLayout = {
  cy: number;
  body: { x: number; y: number; width: number; height: number };
  avatar: { cx: number; cy: number; r: number };
  play: { cx: number; cy: number; zoneEnd: number };
  bars: { x: number; height: number }[];
  duration: { right: number };
  transcriptBadge: { cx: number; cy: number; r: number } | null;
};

export const getAudioElementLayout = (
  element: Pick<
    ExcalidrawAudioElement,
    "width" | "height" | "peaks" | "transcript"
  >,
): AudioElementLayout => {
  const { width, height } = element;
  const cy = height / 2;
  const bodyHeight = height - BODY_Y * 2;
  const transcriptBadge = element.transcript
    ? { cx: width - 16, cy, r: BADGE_R }
    : null;
  const durationRight = transcriptBadge ? width - 30 : width - 14;
  const waveEnd = durationRight - DURATION_WIDTH - 8;
  const barCount = Math.max(0, Math.floor((waveEnd - WAVE_START) / BAR_STEP));
  const maxBarHeight = bodyHeight - 14;
  const { peaks } = element;
  const bars = Array.from({ length: barCount }, (_, i) => {
    // max of the peaks bucket that maps onto this bar
    const start = Math.floor((i * peaks.length) / barCount);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * peaks.length) / barCount),
    );
    let peak = 0;
    for (let j = start; j < end && j < peaks.length; j++) {
      peak = Math.max(peak, peaks[j]);
    }
    return {
      x: WAVE_START + i * BAR_STEP,
      height: Math.max(3, Math.round(peak * maxBarHeight)),
    };
  });

  return {
    cy,
    body: { x: BODY_X, y: BODY_Y, width: width - BODY_X, height: bodyHeight },
    avatar: { cx: AVATAR_CX, cy, r: AVATAR_R },
    play: { cx: PLAY_CX, cy, zoneEnd: PLAY_ZONE_END },
    bars,
    duration: { right: durationRight },
    transcriptBadge,
  };
};

/** Rounded body with a tail pointing at the avatar, in local coordinates. */
export const getAudioBubblePath = (
  element: Pick<ExcalidrawAudioElement, "width" | "height">,
) => {
  const x0 = BODY_X;
  const y0 = BODY_Y;
  const x1 = element.width;
  const y1 = element.height - BODY_Y;
  const r = BODY_RADIUS;
  const cy = element.height / 2;
  return [
    `M ${x0 + r} ${y0}`,
    `L ${x1 - r} ${y0}`,
    `Q ${x1} ${y0}, ${x1} ${y0 + r}`,
    `L ${x1} ${y1 - r}`,
    `Q ${x1} ${y1}, ${x1 - r} ${y1}`,
    `L ${x0 + r} ${y1}`,
    `Q ${x0} ${y1}, ${x0} ${y1 - r}`,
    `L ${x0} ${cy + TAIL_HALF}`,
    `L ${TAIL_TIP_X} ${cy}`,
    `L ${x0} ${cy - TAIL_HALF}`,
    `L ${x0} ${y0 + r}`,
    `Q ${x0} ${y0}, ${x0 + r} ${y0}`,
    "Z",
  ].join(" ");
};

export type AudioHitTarget = "play" | "transcript";

/** Hit zones in local coordinates; the rest of the bubble selects/drags. */
export const getAudioHitTarget = (
  element: ExcalidrawAudioElement,
  localX: number,
  localY: number,
): AudioHitTarget | null => {
  const layout = getAudioElementLayout(element);
  const { body, transcriptBadge } = layout;
  if (transcriptBadge) {
    const dx = localX - transcriptBadge.cx;
    const dy = localY - transcriptBadge.cy;
    // generous radius so the badge is easy to hit at low zoom
    if (dx * dx + dy * dy <= (transcriptBadge.r + 4) ** 2) {
      return "transcript";
    }
  }
  if (
    localX >= body.x &&
    localX <= layout.play.zoneEnd &&
    localY >= body.y &&
    localY <= body.y + body.height
  ) {
    return "play";
  }
  return null;
};

export const isAudioElementPlayable = (element: ExcalidrawAudioElement) =>
  !!element.fileId && element.status !== "error";

export type AudioDrawOp =
  | {
      kind: "circle";
      cx: number;
      cy: number;
      r: number;
      fill: string | null;
      stroke: string | null;
      strokeWidth: number;
    }
  | { kind: "path"; d: string; fill: string }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      opacity: number;
    }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      fontSize: number;
      bold: boolean;
      fill: string;
      align: "center" | "right";
    };

/**
 * The circle avatar (ADR 0034 §6): theme-primary ring, a transparent gap, the
 * colored disc and the glyph. Scales with `r`; the bubble uses r=15. Shared by
 * the bubble and the account settings preview so the two always match.
 */
export const getAudioAvatarDrawOps = (
  avatar: AudioAvatar,
  theme: AppState["theme"],
  { cx, cy, r }: { cx: number; cy: number; r: number },
): AudioDrawOp[] => {
  const scale = r / AVATAR_R;
  return [
    {
      kind: "circle",
      cx,
      cy,
      r,
      fill: null,
      stroke: AUDIO_AVATAR_RING_COLOR[theme === THEME.DARK ? "dark" : "light"],
      strokeWidth: RING_WIDTH * scale,
    },
    {
      kind: "circle",
      cx,
      cy,
      r: AVATAR_DISC_R * scale,
      fill: avatar.color,
      stroke: null,
      strokeWidth: 0,
    },
    {
      kind: "text",
      x: cx,
      y: cy,
      text: avatar.glyph,
      fontSize: 15 * scale,
      bold: true,
      fill: "#ffffff",
      align: "center",
    },
  ];
};

/**
 * Everything drawn on top of the rough bubble body. Canvas and SVG both
 * consume these ops so the two renderers cannot drift apart.
 */
export const getAudioContentDrawOps = (
  element: ExcalidrawAudioElement,
  theme: AppState["theme"],
): AudioDrawOp[] => {
  const isDark = theme === THEME.DARK;
  const ink = applyDarkModeFilter(element.strokeColor, isDark);
  const layout = getAudioElementLayout(element);
  const { cy } = layout;
  const avatar = getAudioAvatar(element.author);
  const playable = isAudioElementPlayable(element);
  const ops: AudioDrawOp[] = [
    ...getAudioAvatarDrawOps(avatar, theme, {
      cx: layout.avatar.cx,
      cy,
      r: layout.avatar.r,
    }),
    {
      kind: "path",
      d: `M ${PLAY_CX - 4} ${cy - 6} L ${PLAY_CX - 4} ${cy + 6} L ${
        PLAY_CX + 6
      } ${cy} Z`,
      fill: ink,
    },
  ];
  for (const bar of layout.bars) {
    ops.push({
      kind: "rect",
      x: bar.x,
      y: cy - bar.height / 2,
      width: BAR_WIDTH,
      height: bar.height,
      fill: ink,
      opacity: playable ? 0.85 : 0.35,
    });
  }
  ops.push({
    kind: "text",
    x: layout.duration.right,
    y: cy,
    text: formatAudioDuration(element.duration),
    fontSize: 14,
    bold: false,
    fill: ink,
    align: "right",
  });
  if (layout.transcriptBadge) {
    const badge = layout.transcriptBadge;
    ops.push(
      {
        kind: "circle",
        cx: badge.cx,
        cy,
        r: badge.r,
        fill: null,
        stroke: ink,
        strokeWidth: 1,
      },
      {
        kind: "text",
        x: badge.cx,
        y: cy,
        text: "文",
        fontSize: 11,
        bold: false,
        fill: ink,
        align: "center",
      },
    );
  }
  return ops;
};

/**
 * Ops for the small playback overlay drawn above a playing bubble, so the
 * static scene never re-renders per frame (ADR 0034 §5): the play triangle
 * is masked and replaced by a pause glyph, and played bars are recoloured.
 */
export const getAudioPlaybackDrawOps = (
  element: ExcalidrawAudioElement,
  theme: AppState["theme"],
  opts: {
    status: "playing" | "paused";
    /** 0..1 */
    progress: number;
    /** used to mask the static glyph when the bubble has no fill */
    canvasBackgroundColor: string;
  },
): AudioDrawOp[] => {
  const isDark = theme === THEME.DARK;
  const ink = applyDarkModeFilter(element.strokeColor, isDark);
  const fill =
    element.backgroundColor === "transparent"
      ? opts.canvasBackgroundColor
      : applyDarkModeFilter(element.backgroundColor, isDark);
  const layout = getAudioElementLayout(element);
  const { cy } = layout;
  const ops: AudioDrawOp[] = [
    {
      kind: "circle",
      cx: PLAY_CX,
      cy,
      r: 9,
      fill,
      stroke: null,
      strokeWidth: 0,
    },
  ];
  if (opts.status === "playing") {
    ops.push(
      {
        kind: "rect",
        x: PLAY_CX - 5,
        y: cy - 6,
        width: 3.5,
        height: 12,
        fill: ink,
        opacity: 1,
      },
      {
        kind: "rect",
        x: PLAY_CX + 1.5,
        y: cy - 6,
        width: 3.5,
        height: 12,
        fill: ink,
        opacity: 1,
      },
    );
  } else {
    ops.push({
      kind: "path",
      d: `M ${PLAY_CX - 4} ${cy - 6} L ${PLAY_CX - 4} ${cy + 6} L ${
        PLAY_CX + 6
      } ${cy} Z`,
      fill: ink,
    });
  }
  const played = Math.round(
    Math.max(0, Math.min(1, opts.progress)) * layout.bars.length,
  );
  const accent = AUDIO_AVATAR_RING_COLOR[isDark ? "dark" : "light"];
  for (const bar of layout.bars.slice(0, played)) {
    ops.push({
      kind: "rect",
      x: bar.x,
      y: cy - bar.height / 2,
      width: BAR_WIDTH,
      height: bar.height,
      fill: accent,
      opacity: 1,
    });
  }
  return ops;
};

const getFont = (op: Extract<AudioDrawOp, { kind: "text" }>) =>
  `${op.bold ? "bold " : ""}${op.fontSize}px ${FONT_FAMILY}`;

export const drawAudioContentOnCanvas = (
  context: CanvasRenderingContext2D,
  ops: readonly AudioDrawOp[],
) => {
  context.save();
  for (const op of ops) {
    switch (op.kind) {
      case "circle": {
        context.beginPath();
        context.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
        if (op.fill) {
          context.fillStyle = op.fill;
          context.fill();
        }
        if (op.stroke) {
          context.strokeStyle = op.stroke;
          context.lineWidth = op.strokeWidth;
          context.stroke();
        }
        break;
      }
      case "path": {
        context.fillStyle = op.fill;
        context.fill(new Path2D(op.d));
        break;
      }
      case "rect": {
        context.globalAlpha *= op.opacity;
        context.fillStyle = op.fill;
        context.fillRect(op.x, op.y, op.width, op.height);
        context.globalAlpha /= op.opacity;
        break;
      }
      case "text": {
        context.font = getFont(op);
        context.fillStyle = op.fill;
        context.textAlign = op.align;
        context.textBaseline = "middle";
        context.fillText(op.text, op.x, op.y);
        break;
      }
    }
  }
  context.restore();
};

export const renderAudioContentToSvg = (
  doc: Document,
  ops: readonly AudioDrawOp[],
): SVGElement[] =>
  ops.map((op) => {
    switch (op.kind) {
      case "circle": {
        const node = doc.createElementNS(SVG_NS, "circle");
        node.setAttribute("cx", `${op.cx}`);
        node.setAttribute("cy", `${op.cy}`);
        node.setAttribute("r", `${op.r}`);
        node.setAttribute("fill", op.fill ?? "none");
        if (op.stroke) {
          node.setAttribute("stroke", op.stroke);
          node.setAttribute("stroke-width", `${op.strokeWidth}`);
        }
        return node;
      }
      case "path": {
        const node = doc.createElementNS(SVG_NS, "path");
        node.setAttribute("d", op.d);
        node.setAttribute("fill", op.fill);
        return node;
      }
      case "rect": {
        const node = doc.createElementNS(SVG_NS, "rect");
        node.setAttribute("x", `${op.x}`);
        node.setAttribute("y", `${op.y}`);
        node.setAttribute("width", `${op.width}`);
        node.setAttribute("height", `${op.height}`);
        node.setAttribute("fill", op.fill);
        node.setAttribute("fill-opacity", `${op.opacity}`);
        return node;
      }
      case "text": {
        const node = doc.createElementNS(SVG_NS, "text");
        node.setAttribute("x", `${op.x}`);
        node.setAttribute("y", `${op.y}`);
        node.setAttribute("font-family", FONT_FAMILY);
        node.setAttribute("font-size", `${op.fontSize}px`);
        if (op.bold) {
          node.setAttribute("font-weight", "bold");
        }
        node.setAttribute("fill", op.fill);
        node.setAttribute(
          "text-anchor",
          op.align === "right" ? "end" : "middle",
        );
        node.setAttribute("dominant-baseline", "central");
        node.textContent = op.text;
        return node;
      }
      default:
        return assertNever(op, "unknown audio draw op");
    }
  });
