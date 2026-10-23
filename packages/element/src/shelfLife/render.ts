import { applyDarkModeFilter } from "@excalidraw/common";

import { getCornerRadius } from "../utils";

import {
  getElementShelfLifeState,
  getShelfLifeBadge,
  getShelfLifeRoot,
} from "./helpers";

import type { ExcalidrawElement } from "../types";

// The static canvas is NOT CSS-inverted (only the interactive UI canvas is).
// These warm colors are shared by screen, PNG and SVG without a second filter.
export const SHELF_LIFE_PAPER = "#eab94f";
export const SHELF_LIFE_FOLD = "#bd822b";
export const SHELF_LIFE_DUE = "#e08a12";
/** Tint strength over the note. Dark fills need a little more to read warm. */
export const getShelfLifePaperAlpha = (theme?: string) =>
  theme === "dark" ? 0.38 : 0.3;
// Digits must stay legible at small sizes; the hand-drawn font is not.
export const SHELF_LIFE_BADGE_FONT = "Helvetica, Arial, sans-serif";
export const SHELF_LIFE_BADGE_MIN_WIDTH = 28;
export const SHELF_LIFE_BADGE_MIN_HEIGHT = 20;

/** Outline in element-local coordinates, used to clip every overlay. */
const getOutline = (el: ExcalidrawElement) => {
  const w = Math.max(0, el.width);
  const h = Math.max(0, el.height);
  if (el.type === "ellipse") {
    return `M 0 ${h / 2} A ${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2} A ${w / 2} ${
      h / 2
    } 0 1 0 0 ${h / 2} Z`;
  }
  if (el.type === "diamond") {
    return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
  }
  const r = Math.min(getCornerRadius(Math.min(w, h), el), w / 2, h / 2);
  return `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${
    w - r
  } ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
};

/**
 * Expired paper: the outline (for the tint) and, on boxes only, a dog-ear in
 * the bottom-right corner. Curved and pointed shapes have no corner to fold.
 */
export const getShelfLifeGeometry = (el: ExcalidrawElement) => {
  const w = Math.max(0, el.width);
  const h = Math.max(0, el.height);
  // Text is not paper either: its box is invisible, so a dog-ear floats.
  const foldable =
    el.type !== "ellipse" && el.type !== "diamond" && el.type !== "text";
  const size = foldable ? Math.min(22, w / 5, h / 4) : 0;
  return {
    outline: getOutline(el),
    // The flap lies on the note; its hypotenuse is the crease.
    fold: `M ${w - size} ${h} L ${w} ${h - size} L ${w - size} ${h - size} Z`,
    crease: `M ${w - size} ${h} L ${w} ${h - size}`,
    size,
  };
};

export type ShelfLifeBadgeLayout = {
  /** Pill path in element-local coordinates. */
  pill: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  clock: { cx: number; cy: number; r: number };
  /** Empty when the pill is too small for the date. */
  label: string;
  textX: number;
  textY: number;
  /** Text elements carry the badge outside their box: never clip it. */
  clip: boolean;
};

const pillPath = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w - r} ${
    y + h
  } H ${x + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
};

/**
 * One layout for screen, PNG and SVG. The pill sits in the top-right corner
 * of the shape's inscribed box (not its bounding box), shrinks to a clock
 * when the date does not fit, and disappears on tiny notes. Standalone text
 * gets the pill just past its right edge so it never covers the glyphs.
 */
export const getShelfLifeBadgeLayout = (
  element: ExcalidrawElement,
  label: string,
): ShelfLifeBadgeLayout | null => {
  if (
    element.width < SHELF_LIFE_BADGE_MIN_WIDTH ||
    element.height < SHELF_LIFE_BADGE_MIN_HEIGHT
  ) {
    return null;
  }
  const w = element.width;
  const h = element.height;
  const isText = element.type === "text";
  const fontSize = isText
    ? Math.min(14, Math.max(10, h * 0.6))
    : Math.min(14, Math.max(10, Math.min(w, h) * 0.12));
  const height = Math.round(fontSize * 1.6);
  const pad = fontSize * 0.5;
  const clockR = fontSize * 0.42;
  const gap = fontSize * 0.35;
  // Approximate advance of a sans-serif digit or slash; dates are short.
  const textWidth = label.length * fontSize * 0.58;
  const full = pad + clockR * 2 + gap + textWidth + pad;
  const compact = pad * 2 + clockR * 2;

  let right: number;
  let top: number;
  let room: number;
  if (isText) {
    right = w + gap + full;
    top = Math.max(0, (h - height) / 2);
    room = Infinity;
  } else {
    // Top-right corner of the inscribed box, plus a small margin.
    const [cx, cy] =
      element.type === "ellipse"
        ? [w * 0.854, h * 0.146]
        : element.type === "diamond"
        ? [w * 0.75, h * 0.25]
        : [w, 0];
    // Keep clear of the (rough, ~2px) stroke even on small notes.
    const margin = Math.max(4, Math.min(8, w * 0.05, h * 0.06));
    right = cx - margin;
    top = cy + margin;
    // Width available inside the inscribed box at this corner.
    room =
      (element.type === "ellipse"
        ? w * 0.708
        : element.type === "diamond"
        ? w * 0.5
        : w) -
      2 * margin;
    if (top + height > h * 0.6) {
      return null;
    }
  }
  const showLabel = full <= room * 0.75;
  if (!showLabel && compact > room * 0.6) {
    return null;
  }
  const width = showLabel ? full : compact;
  const x = right - width;
  const y = top;
  const clockCx = x + pad + clockR;
  const cy = y + height / 2;
  return {
    pill: pillPath(x, y, width, height),
    x,
    y,
    width,
    height,
    fontSize,
    clock: { cx: clockCx, cy, r: clockR },
    label: showLabel ? label : "",
    textX: clockCx + clockR + gap + textWidth / 2,
    textY: cy,
    clip: !isText,
  };
};

const getBadgeInk = (element: ExcalidrawElement, theme: string | undefined) => {
  const base =
    element.strokeColor && element.strokeColor !== "transparent"
      ? element.strokeColor
      : "#1e1e1e";
  return applyDarkModeFilter(base, theme === "dark");
};

export const getShelfLifeBadgeForElement = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  theme?: string,
  now = Date.now(),
) => {
  const badge = getShelfLifeBadge(element, elements, now);
  const layout = badge && getShelfLifeBadgeLayout(element, badge.label);
  if (!badge || !layout) {
    return null;
  }
  const dark = theme === "dark";
  return {
    ...layout,
    dueSoon: badge.dueSoon,
    ink: getBadgeInk(element, theme),
    accent: applyDarkModeFilter(SHELF_LIFE_DUE, dark),
    fill: applyDarkModeFilter("#ffffff", dark),
  };
};

export const renderShelfLifeOverlay = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  context: CanvasRenderingContext2D,
  scrollX: number,
  scrollY: number,
  theme?: string,
  now = Date.now(),
) => {
  if (
    getShelfLifeRoot(element, elements) !== element ||
    element.width <= 0 ||
    element.height <= 0
  ) {
    return;
  }
  const expired = getElementShelfLifeState(element, elements, now).expired;
  const badge = expired
    ? null
    : getShelfLifeBadgeForElement(element, elements, theme, now);
  if (!expired && !badge) {
    return;
  }
  context.save();
  context.translate(
    element.x + scrollX + element.width / 2,
    element.y + scrollY + element.height / 2,
  );
  context.rotate(element.angle);
  context.translate(-element.width / 2, -element.height / 2);
  const alpha = context.globalAlpha;
  const geometry = getShelfLifeGeometry(element);
  const outline = new Path2D(geometry.outline);

  if (expired) {
    context.save();
    context.clip(outline);
    context.globalAlpha = alpha * getShelfLifePaperAlpha(theme);
    context.fillStyle = SHELF_LIFE_PAPER;
    context.fill(outline);
    if (geometry.size >= 4) {
      context.globalAlpha = alpha * 0.85;
      context.fillStyle = SHELF_LIFE_FOLD;
      context.fill(new Path2D(geometry.fold));
      context.globalAlpha = alpha;
      context.strokeStyle = applyDarkModeFilter(
        element.strokeColor || "#1e1e1e",
        theme === "dark",
      );
      context.lineWidth = Math.max(1, element.strokeWidth * 0.6);
      context.lineCap = "round";
      context.stroke(new Path2D(geometry.crease));
    }
    context.restore();
  }

  if (badge) {
    const color = badge.dueSoon ? badge.accent : badge.ink;
    const pill = new Path2D(badge.pill);
    context.save();
    if (badge.clip) {
      context.clip(outline);
    }
    context.globalAlpha = alpha * 0.85;
    context.fillStyle = badge.fill;
    context.fill(pill);
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.stroke(pill);
    const { cx, cy, r } = badge.clock;
    context.lineWidth = Math.max(1, badge.fontSize / 10);
    context.lineCap = "round";
    context.beginPath();
    context.arc(cx, cy, r, 0, Math.PI * 2);
    context.moveTo(cx, cy);
    context.lineTo(cx, cy - r * 0.6);
    context.moveTo(cx, cy);
    context.lineTo(cx + r * 0.5, cy);
    context.stroke();
    if (badge.label) {
      context.fillStyle = color;
      context.font = `${badge.fontSize}px ${SHELF_LIFE_BADGE_FONT}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(badge.label, badge.textX, badge.textY);
    }
    context.restore();
  }

  context.restore();
};
