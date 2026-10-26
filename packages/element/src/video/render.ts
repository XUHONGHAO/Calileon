import { SVG_NS, THEME, assertNever } from "@excalidraw/common";

import type { AppState } from "@excalidraw/excalidraw/types";

import { formatVideoDuration, isVideoElementPlayable } from "./helpers";

import type { ExcalidrawVideoElement } from "../types";

// Local layout (element origin at top-left, angle always 0):
//   ┌──────────────────────────┐
//   │          poster          │
//   │           (▶)            │
//   │                 🔇 [0:12]│
//   └──────────────────────────┘
const CORNER_RADIUS = 8;
const PLAY_R_MAX = 28;
const PLAY_R_MIN = 12;
const PILL_HEIGHT = 20;
const PILL_FONT_SIZE = 12;
const PILL_MARGIN = 8;
const PILL_PADDING_X = 7;
// deterministic width so canvas and SVG agree without measuring text
const PILL_CHAR_WIDTH = 7;
const MUTE_SIZE = 16;
const OVERLAY_FILL = "rgba(0, 0, 0, 0.55)";
const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";

// Tabler `camera` (24×24 stroke icon), used for the placeholder
const CAMERA_ICON_PATHS = [
  "M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2",
  "M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
];

export type VideoElementLayout = {
  radius: number;
  play: { cx: number; cy: number; r: number };
  pill: { x: number; y: number; width: number; height: number } | null;
  mute: { x: number; y: number; size: number } | null;
  icon: { x: number; y: number; size: number };
};

export const getVideoElementLayout = (
  element: Pick<
    ExcalidrawVideoElement,
    "width" | "height" | "duration" | "hasAudio"
  >,
): VideoElementLayout => {
  const { width, height } = element;
  const minSide = Math.min(width, height);
  const radius = Math.min(CORNER_RADIUS, minSide / 4);
  const playR = Math.max(PLAY_R_MIN, Math.min(PLAY_R_MAX, minSide * 0.12));
  const label = formatVideoDuration(element.duration);
  const pillWidth = label.length * PILL_CHAR_WIDTH + PILL_PADDING_X * 2;
  // badges only when there is room for them next to the play button
  const roomy = width >= pillWidth + PILL_MARGIN * 2 && height >= 64;
  const pill = roomy
    ? {
        x: width - PILL_MARGIN - pillWidth,
        y: height - PILL_MARGIN - PILL_HEIGHT,
        width: pillWidth,
        height: PILL_HEIGHT,
      }
    : null;
  const mute =
    pill && !element.hasAudio
      ? {
          x: pill.x - 4 - PILL_HEIGHT,
          y: pill.y,
          size: PILL_HEIGHT,
        }
      : null;
  const iconSize = Math.max(16, Math.min(48, minSide * 0.25));
  return {
    radius,
    play: { cx: width / 2, cy: height / 2, r: playR },
    pill,
    mute,
    icon: {
      x: width / 2 - iconSize / 2,
      // placeholder icon sits above the play button
      y: Math.max(4, height / 2 - playR - iconSize - 6),
      size: iconSize,
    },
  };
};

export type VideoHitTarget = "play";

/** Hit zone in local coordinates; the rest of the element selects/drags. */
export const getVideoHitTarget = (
  element: ExcalidrawVideoElement,
  localX: number,
  localY: number,
): VideoHitTarget | null => {
  const { play } = getVideoElementLayout(element);
  const dx = localX - play.cx;
  const dy = localY - play.cy;
  // a little generous so it is easy to hit at low zoom
  return dx * dx + dy * dy <= (play.r + 4) ** 2 ? "play" : null;
};

export type VideoDrawOp =
  | {
      kind: "poster";
      /** draw the poster cover-fit, clipped to the rounded rect */
      dataURL: string;
      width: number;
      height: number;
      radius: number;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
      fill: string;
    }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string }
  | {
      kind: "path";
      d: string;
      /** local 24×24 icon space → element space; strokeWidth is in icon space */
      transform: { x: number; y: number; scale: number } | null;
      fill: string | null;
      stroke: string | null;
      strokeWidth: number;
    }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      fontSize: number;
      fill: string;
    };

/**
 * Everything drawn for a video element. Canvas and SVG both consume these
 * ops so the two renderers cannot drift apart. `posterReady` says whether
 * the poster can be drawn now (canvas needs it decoded; SVG embeds it).
 */
export const getVideoContentDrawOps = (
  element: ExcalidrawVideoElement,
  theme: AppState["theme"],
  posterReady: boolean,
): VideoDrawOp[] => {
  const isDark = theme === THEME.DARK;
  const layout = getVideoElementLayout(element);
  const { width, height } = element;
  const { radius } = layout;
  const playable = isVideoElementPlayable(element);
  const ops: VideoDrawOp[] = [];

  if (element.poster && posterReady) {
    ops.push({
      kind: "poster",
      dataURL: element.poster,
      width,
      height,
      radius,
    });
  } else {
    ops.push({
      kind: "rect",
      x: 0,
      y: 0,
      width,
      height,
      radius,
      fill: isDark ? "#2e2e2e" : "#e7e7e7",
    });
    const scale = layout.icon.size / 24;
    for (const d of CAMERA_ICON_PATHS) {
      ops.push({
        kind: "path",
        d,
        transform: { x: layout.icon.x, y: layout.icon.y, scale },
        fill: null,
        stroke: "#888888",
        strokeWidth: 2,
      });
    }
  }

  const { play } = layout;
  ops.push({
    kind: "circle",
    cx: play.cx,
    cy: play.cy,
    r: play.r,
    fill: OVERLAY_FILL,
  });
  const t = play.r * 0.42;
  ops.push({
    kind: "path",
    d: `M ${play.cx - t * 0.8} ${play.cy - t} L ${play.cx - t * 0.8} ${
      play.cy + t
    } L ${play.cx + t * 1.1} ${play.cy} Z`,
    transform: null,
    fill: playable ? "#ffffff" : "rgba(255, 255, 255, 0.45)",
    stroke: null,
    strokeWidth: 0,
  });
  if (!playable) {
    // a slash through the play glyph: the file is missing or failed
    ops.push({
      kind: "path",
      d: `M ${play.cx - t * 1.3} ${play.cy + t * 1.3} L ${play.cx + t * 1.3} ${
        play.cy - t * 1.3
      }`,
      transform: null,
      fill: null,
      stroke: "#ffffff",
      strokeWidth: 2,
    });
  }

  if (layout.pill) {
    const { pill } = layout;
    ops.push(
      {
        kind: "rect",
        ...pill,
        radius: pill.height / 2,
        fill: OVERLAY_FILL,
      },
      {
        kind: "text",
        x: pill.x + pill.width / 2,
        y: pill.y + pill.height / 2,
        text: formatVideoDuration(element.duration),
        fontSize: PILL_FONT_SIZE,
        fill: "#ffffff",
      },
    );
  }
  if (layout.mute) {
    const { mute } = layout;
    const s = MUTE_SIZE / 24;
    const ox = mute.x + (mute.size - MUTE_SIZE) / 2;
    const oy = mute.y + (mute.size - MUTE_SIZE) / 2;
    ops.push(
      {
        kind: "rect",
        x: mute.x,
        y: mute.y,
        width: mute.size,
        height: mute.size,
        radius: mute.size / 2,
        fill: OVERLAY_FILL,
      },
      {
        // speaker
        kind: "path",
        d: "M4 9h3l5 -4v14l-5 -4h-3z",
        transform: { x: ox, y: oy, scale: s },
        fill: "#ffffff",
        stroke: null,
        strokeWidth: 0,
      },
      {
        // ✕
        kind: "path",
        d: "M15 9l6 6m0 -6l-6 6",
        transform: { x: ox, y: oy, scale: s },
        fill: null,
        stroke: "#ffffff",
        strokeWidth: 2,
      },
    );
  }
  return ops;
};

const roundedRectPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(x, y, width, height, radius);
  } else {
    context.rect(x, y, width, height);
  }
};

/** cover-fit source rect of an image inside a `width × height` box */
export const getCoverSourceRect = (
  naturalWidth: number,
  naturalHeight: number,
  width: number,
  height: number,
) => {
  if (!naturalWidth || !naturalHeight || !width || !height) {
    return { sx: 0, sy: 0, sw: naturalWidth, sh: naturalHeight };
  }
  const scale = Math.max(width / naturalWidth, height / naturalHeight);
  const sw = width / scale;
  const sh = height / scale;
  return {
    sx: (naturalWidth - sw) / 2,
    sy: (naturalHeight - sh) / 2,
    sw,
    sh,
  };
};

export const drawVideoContentOnCanvas = (
  context: CanvasRenderingContext2D,
  ops: readonly VideoDrawOp[],
  getPoster: (dataURL: string) => HTMLImageElement | null,
) => {
  context.save();
  for (const op of ops) {
    switch (op.kind) {
      case "poster": {
        const image = getPoster(op.dataURL);
        if (!image) {
          break;
        }
        context.save();
        roundedRectPath(context, 0, 0, op.width, op.height, op.radius);
        context.clip();
        const { sx, sy, sw, sh } = getCoverSourceRect(
          image.naturalWidth,
          image.naturalHeight,
          op.width,
          op.height,
        );
        context.drawImage(image, sx, sy, sw, sh, 0, 0, op.width, op.height);
        context.restore();
        break;
      }
      case "rect": {
        context.fillStyle = op.fill;
        roundedRectPath(context, op.x, op.y, op.width, op.height, op.radius);
        context.fill();
        break;
      }
      case "circle": {
        context.fillStyle = op.fill;
        context.beginPath();
        context.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
        context.fill();
        break;
      }
      case "path": {
        context.save();
        if (op.transform) {
          context.translate(op.transform.x, op.transform.y);
          context.scale(op.transform.scale, op.transform.scale);
        }
        const path = new Path2D(op.d);
        if (op.fill) {
          context.fillStyle = op.fill;
          context.fill(path);
        }
        if (op.stroke) {
          context.strokeStyle = op.stroke;
          // in the op's own space, so icon strokes scale with the icon
          context.lineWidth = op.strokeWidth;
          context.lineCap = "round";
          context.lineJoin = "round";
          context.stroke(path);
        }
        context.restore();
        break;
      }
      case "text": {
        context.font = `${op.fontSize}px ${FONT_FAMILY}`;
        context.fillStyle = op.fill;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(op.text, op.x, op.y);
        break;
      }
      default:
        assertNever(op, "unknown video draw op");
    }
  }
  context.restore();
};

export const renderVideoContentToSvg = (
  doc: Document,
  ops: readonly VideoDrawOp[],
  /** unique per element, used for the poster clip path */
  clipId: string,
): SVGElement[] => {
  const nodes: SVGElement[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case "poster": {
        const clip = doc.createElementNS(SVG_NS, "clipPath");
        clip.setAttribute("id", clipId);
        const clipRect = doc.createElementNS(SVG_NS, "rect");
        clipRect.setAttribute("width", `${op.width}`);
        clipRect.setAttribute("height", `${op.height}`);
        clipRect.setAttribute("rx", `${op.radius}`);
        clip.appendChild(clipRect);
        const image = doc.createElementNS(SVG_NS, "image");
        image.setAttribute("href", op.dataURL);
        image.setAttribute("width", `${op.width}`);
        image.setAttribute("height", `${op.height}`);
        image.setAttribute("preserveAspectRatio", "xMidYMid slice");
        image.setAttribute("clip-path", `url(#${clipId})`);
        nodes.push(clip, image);
        break;
      }
      case "rect": {
        const node = doc.createElementNS(SVG_NS, "rect");
        node.setAttribute("x", `${op.x}`);
        node.setAttribute("y", `${op.y}`);
        node.setAttribute("width", `${op.width}`);
        node.setAttribute("height", `${op.height}`);
        node.setAttribute("rx", `${op.radius}`);
        node.setAttribute("fill", op.fill);
        nodes.push(node);
        break;
      }
      case "circle": {
        const node = doc.createElementNS(SVG_NS, "circle");
        node.setAttribute("cx", `${op.cx}`);
        node.setAttribute("cy", `${op.cy}`);
        node.setAttribute("r", `${op.r}`);
        node.setAttribute("fill", op.fill);
        nodes.push(node);
        break;
      }
      case "path": {
        const node = doc.createElementNS(SVG_NS, "path");
        node.setAttribute("d", op.d);
        node.setAttribute("fill", op.fill ?? "none");
        if (op.stroke) {
          node.setAttribute("stroke", op.stroke);
          node.setAttribute("stroke-width", `${op.strokeWidth}`);
          node.setAttribute("stroke-linecap", "round");
          node.setAttribute("stroke-linejoin", "round");
        }
        if (op.transform) {
          node.setAttribute(
            "transform",
            `translate(${op.transform.x} ${op.transform.y}) scale(${op.transform.scale})`,
          );
        }
        nodes.push(node);
        break;
      }
      case "text": {
        const node = doc.createElementNS(SVG_NS, "text");
        node.setAttribute("x", `${op.x}`);
        node.setAttribute("y", `${op.y}`);
        node.setAttribute("font-family", FONT_FAMILY);
        node.setAttribute("font-size", `${op.fontSize}px`);
        node.setAttribute("fill", op.fill);
        node.setAttribute("text-anchor", "middle");
        node.setAttribute("dominant-baseline", "central");
        node.textContent = op.text;
        nodes.push(node);
        break;
      }
      default:
        assertNever(op, "unknown video draw op");
    }
  }
  return nodes;
};
