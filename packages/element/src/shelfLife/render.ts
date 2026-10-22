import {
  DEFAULT_FONT_FAMILY,
  applyDarkModeFilter,
  getFontFamilyString,
} from "@excalidraw/common";

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
export const SHELF_LIFE_BADGE_MIN_WIDTH = 28;
export const SHELF_LIFE_BADGE_MIN_HEIGHT = 20;
export const getShelfLifeBadgePadding = (element: ExcalidrawElement) =>
  Math.min(10, element.width / 2, element.height / 2);
export const getShelfLifeBadgeSize = (element: ExcalidrawElement) =>
  Math.min(16, element.width / 5, element.height / 3.5);
export const getShelfLifeGeometry = (el: ExcalidrawElement) => {
  const w = Math.max(0, el.width);
  const h = Math.max(0, el.height);
  const size = Math.min(16, w / 4, h / 4);
  let outline: string;
  let x = w;
  let y = h;
  if (el.type === "ellipse") {
    outline = `M 0 ${h / 2} A ${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2} A ${
      w / 2
    } ${h / 2} 0 1 0 0 ${h / 2} Z`;
    x = w * 0.8;
    y = h * 0.8;
  } else if (el.type === "diamond") {
    outline = `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    x = w * 0.75;
    y = h * 0.75;
  } else {
    const r = Math.min(getCornerRadius(Math.min(w, h), el), w / 2, h / 2);
    outline = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${
      w - r
    } ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  }
  return {
    outline,
    fold: `M ${x - size} ${y} L ${x} ${y - size} L ${x} ${y} Z`,
    size,
  };
};

/**
 * The canvas-side affordance for a note that still has a deadline: a small
 * clock plus its local date in the note's own ink. Expired notes drop the
 * badge and communicate through the paper tint and folded corner instead.
 */
export const getShelfLifeBadgeLayout = (element: ExcalidrawElement) => {
  if (
    element.width < SHELF_LIFE_BADGE_MIN_WIDTH ||
    element.height < SHELF_LIFE_BADGE_MIN_HEIGHT
  ) {
    return null;
  }
  const size = getShelfLifeBadgeSize(element);
  const padding = getShelfLifeBadgePadding(element);
  // Keep the badge inside curved and diamond outlines instead of floating in
  // the empty corner of their bounding box.
  const rightInset =
    element.type === "ellipse"
      ? Math.max(padding, element.width * 0.16)
      : element.type === "diamond"
      ? Math.max(padding, element.width * 0.24)
      : padding;
  const topInset =
    element.type === "ellipse"
      ? Math.max(padding, element.height * 0.2)
      : element.type === "diamond"
      ? Math.max(padding, element.height * 0.18)
      : padding;
  return {
    size,
    x: element.width - rightInset - size,
    y: topInset,
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
  const layout = getShelfLifeBadgeLayout(element);
  if (!badge || !layout) {
    return null;
  }
  return {
    ...layout,
    ...badge,
    // Standalone text is tight; keep the clock and skip the date so it never
    // sits on top of the glyphs the user wrote.
    label: element.type === "text" ? "" : badge.label,
    ink: getBadgeInk(element, theme),
    accent: applyDarkModeFilter(SHELF_LIFE_DUE, theme === "dark"),
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

  if (expired) {
    const geometry = getShelfLifeGeometry(element);
    const outline = new Path2D(geometry.outline);
    context.save();
    context.clip(outline);
    context.globalAlpha = alpha * 0.16;
    context.fillStyle = SHELF_LIFE_PAPER;
    context.fill(outline);
    if (geometry.size >= 2) {
      context.globalAlpha = alpha * 0.65;
      context.fillStyle = SHELF_LIFE_FOLD;
      context.fill(new Path2D(geometry.fold));
    }
    context.restore();
  }

  if (badge) {
    const { size, x, y, label, dueSoon, ink, accent } = badge;
    const radius = size / 2;
    const cx = x + radius;
    const cy = y + radius;
    context.save();
    context.clip(new Path2D(getShelfLifeGeometry(element).outline));
    context.globalAlpha = alpha;
    context.strokeStyle = dueSoon ? accent : ink;
    context.fillStyle = dueSoon ? accent : ink;
    context.lineWidth = Math.max(0.8, size / 12);
    context.lineCap = "round";
    context.beginPath();
    context.arc(cx, cy, radius * 0.82, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(cx, cy);
    context.lineTo(cx, cy - radius * 0.48);
    context.moveTo(cx, cy);
    context.lineTo(cx + radius * 0.4, cy);
    context.stroke();
    if (size >= 9) {
      context.font = `${Math.round(size * 0.62)}px ${getFontFamilyString({
        fontFamily: DEFAULT_FONT_FAMILY,
      })}`;
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(label, x + size + size * 0.3, cy);
    }
    context.restore();
  }

  context.restore();
};
