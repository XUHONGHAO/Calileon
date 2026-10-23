import { applyDarkModeFilter } from "@excalidraw/common";

import { getCornerRadius } from "../utils";

import {
  getElementShelfLifeState,
  getShelfLifeBadge,
  getShelfLifeRoot,
  isShelfLifeVisualsEnabled,
} from "./helpers";

import type { ExcalidrawElement } from "../types";

// The static canvas is NOT CSS-inverted (only the interactive UI canvas is).
// These warm colors are shared by screen, PNG and SVG without a second filter.
export const SHELF_LIFE_PAPER = "#eab94f";
export const SHELF_LIFE_FOLD = "#bd822b";
/** Tint strength over the note. Dark fills need a little more to read warm. */
export const getShelfLifePaperAlpha = (theme?: string) =>
  theme === "dark" ? 0.38 : 0.3;
// Digits must stay legible at small sizes; the hand-drawn font is not.
export const SHELF_LIFE_BADGE_FONT = "Helvetica, Arial, sans-serif";

/** Rounded-rect outline in element-local coordinates (clips the tint). */
const getOutline = (el: ExcalidrawElement) => {
  const w = Math.max(0, el.width);
  const h = Math.max(0, el.height);
  const r = Math.min(getCornerRadius(Math.min(w, h), el), w / 2, h / 2);
  return `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${
    w - r
  } ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
};

/** Expired paper: the outline (for the tint) and a bottom-right dog-ear. */
export const getShelfLifeGeometry = (el: ExcalidrawElement) => {
  const w = Math.max(0, el.width);
  const h = Math.max(0, el.height);
  const size = Math.min(22, w / 5, h / 4);
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
  label: string;
  textX: number;
  textY: number;
};

const pillPath = (x: number, y: number, w: number, h: number) => {
  const r = h / 2;
  return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w - r} ${
    y + h
  } H ${x + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
};

// Screen pixels. The pill is editor UI: same size at every zoom level.
const BADGE_FONT_PX = 11.5;
// Selection frame (padding + dashed margin) plus a little air. Constant at
// every note size: the pill never drifts away from small notes.
const BADGE_GAP_PX = 14;
// Calileon brand teal, the fallback when no selection color is passed in.
const BADGE_COLOR = "#1f9e8f";

/**
 * Above the note at a fixed distance, its right edge flush with the note's
 * right edge at every size. On narrow notes it may sit under the centered
 * rotation handle; the handle is painted after it and stays on top.
 */
export const getShelfLifeBadgeLayout = (
  element: ExcalidrawElement,
  label: string,
  zoom = 1,
): ShelfLifeBadgeLayout | null => {
  const w = element.width;
  if (w <= 0 || element.height <= 0) {
    return null;
  }
  const unit = 1 / Math.max(zoom, 0.01);
  const fontSize = BADGE_FONT_PX * unit;
  const height = fontSize * 1.75;
  const pad = fontSize * 0.6;
  const clockR = fontSize * 0.42;
  const gap = fontSize * 0.4;
  // Approximate advance of a sans-serif digit, slash or colon.
  const textWidth = label.length * fontSize * 0.58;
  const width = pad + clockR * 2 + gap + textWidth + pad;
  const x = w - width;
  const y = -height - BADGE_GAP_PX * unit;
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
    label,
    textX: clockCx + clockR + gap + textWidth / 2,
    textY: cy,
  };
};

export const getShelfLifeBadgeForElement = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  theme?: string,
  now = Date.now(),
  zoom = 1,
) => {
  const badge = getShelfLifeBadge(element, elements, now);
  const layout = badge && getShelfLifeBadgeLayout(element, badge.label, zoom);
  if (!badge || !layout) {
    return null;
  }
  return {
    ...layout,
    dueSoon: badge.dueSoon,
    fill: applyDarkModeFilter("#ffffff", theme === "dark"),
  };
};

/** Expired paper only. This is content: it is drawn on screen and exported. */
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
  if (!getElementShelfLifeState(element, elements, now).expired) {
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
};

/**
 * The deadline pill is editor UI, not content: the interactive canvas draws it
 * for selected notes only, so it never clutters reading or lands in exports.
 * That canvas is CSS-inverted in dark mode, so it always uses light colors,
 * and it is drawn in the selection color, like the selection frame.
 */
export const renderShelfLifeBadge = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  context: CanvasRenderingContext2D,
  scrollX: number,
  scrollY: number,
  now = Date.now(),
  zoom = 1,
  color = BADGE_COLOR,
) => {
  const badge = isShelfLifeVisualsEnabled()
    ? getShelfLifeBadgeForElement(element, elements, "light", now, zoom)
    : null;
  if (!badge) {
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
  const pill = new Path2D(badge.pill);
  context.globalAlpha = alpha * 0.92;
  context.fillStyle = badge.fill;
  context.fill(pill);
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  // Scene units per screen pixel: hairlines stay 1px at any zoom.
  const px = badge.fontSize / BADGE_FONT_PX;
  context.lineWidth = px;
  context.stroke(pill);
  const { cx, cy, r } = badge.clock;
  context.lineWidth = 1.25 * px;
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
};
