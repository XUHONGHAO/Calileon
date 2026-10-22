import { getCornerRadius } from "../utils";

import { getElementShelfLifeState, getShelfLifeRoot } from "./helpers";

import type { ExcalidrawElement } from "../types";

// The static canvas is NOT CSS-inverted (only the interactive UI canvas is).
// These warm colors are shared by screen, PNG and SVG without a second filter.
export const SHELF_LIFE_PAPER = "#eab94f";
export const SHELF_LIFE_FOLD = "#bd822b";
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
export const renderShelfLifeOverlay = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  context: CanvasRenderingContext2D,
  scrollX: number,
  scrollY: number,
  now = Date.now(),
) => {
  if (
    getShelfLifeRoot(element, elements) !== element ||
    !getElementShelfLifeState(element, elements, now).expired ||
    element.width <= 0 ||
    element.height <= 0
  ) {
    return;
  }
  const geometry = getShelfLifeGeometry(element);
  context.save();
  context.translate(
    element.x + scrollX + element.width / 2,
    element.y + scrollY + element.height / 2,
  );
  context.rotate(element.angle);
  context.translate(-element.width / 2, -element.height / 2);
  const outline = new Path2D(geometry.outline);
  context.clip(outline);
  const alpha = context.globalAlpha;
  context.globalAlpha = alpha * 0.16;
  context.fillStyle = SHELF_LIFE_PAPER;
  context.fill(outline);
  if (geometry.size >= 2) {
    context.globalAlpha = alpha * 0.65;
    context.fillStyle = SHELF_LIFE_FOLD;
    context.fill(new Path2D(geometry.fold));
  }
  context.restore();
};
