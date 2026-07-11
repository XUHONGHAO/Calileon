import {
  getLuminaGameData,
  getLuminaLightData,
  getLuminaMaterialData,
} from "@excalidraw/element/lumina";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

const serializeOptionalGeometry = (
  element: NonDeletedExcalidrawElement,
): string => {
  const geometry: Record<string, unknown> = {};
  if ("points" in element) {
    geometry.points = element.points;
  }
  if ("startBinding" in element) {
    geometry.startBinding = element.startBinding;
    geometry.endBinding = element.endBinding;
  }
  if ("containerId" in element) {
    geometry.containerId = element.containerId;
  }
  if ("roundness" in element) {
    geometry.roundness = element.roundness;
  }
  return JSON.stringify(geometry);
};

/**
 * Stable signature for geometry and Lumina metadata consumed by the CPU
 * renderer. Explicit fields protect cache correctness even when tests or
 * import/restore code create a new element without incrementing its version.
 */
export const getLuminaElementSignature = (
  element: NonDeletedExcalidrawElement,
): string =>
  [
    element.id,
    element.type,
    element.version,
    element.versionNonce,
    element.x,
    element.y,
    element.width,
    element.height,
    element.angle,
    element.opacity,
    element.strokeColor,
    element.backgroundColor,
    element.strokeWidth,
    serializeOptionalGeometry(element),
    JSON.stringify(getLuminaMaterialData(element)),
    JSON.stringify(getLuminaLightData(element)),
    JSON.stringify(getLuminaGameData(element)),
  ].join("\u001f");

export const getLuminaElementsSignature = (
  elements: readonly NonDeletedExcalidrawElement[],
): string =>
  `${elements.length}\u001e${elements
    .map(getLuminaElementSignature)
    .join("\u001e")}`;
