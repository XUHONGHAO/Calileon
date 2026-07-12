import {
  curveLength,
  curveLengthAtParameter,
  curveTangent,
  pointFrom,
  type Curve,
  type GlobalPoint,
} from "@excalidraw/math";

import { getElementShape } from "../shape";

import { getLineTone } from "./helpers";

import type { ElementsMap, ExcalidrawLinearElement } from "../types";
import type { LineTone } from "./types";

export const LINE_TONE_MARKER_MIN_ZOOM = 0.4;
export const LINE_TONE_MARKER_OFFSET = 12;

/**
 * Returns an ephemeral rendering-only element. Persisted element style is
 * never changed, so clearing a tone restores the user's exact original style.
 */
export const getLineToneRenderElement = <T extends ExcalidrawLinearElement>(
  element: T,
): T => {
  switch (getLineTone(element)) {
    case "certain":
      return { ...element, strokeStyle: "solid" };
    case "possible":
      return { ...element, strokeStyle: "dashed" };
    case "blocked":
      return {
        ...element,
        strokeStyle: "solid",
        strokeWidth:
          element.strokeWidth + Math.max(1, element.strokeWidth * 0.5),
      };
    case "questioned":
      return { ...element, strokeStyle: "dotted" };
    default:
      return element;
  }
};

export type LineTonePathAnchor = {
  point: GlobalPoint;
  /** Unit tangent following the visible path direction. */
  tangent: readonly [number, number];
  /** Unit normal used to keep the marker clear of bound text. */
  normal: readonly [number, number];
};

const parameterAtLength = (curve: Curve<GlobalPoint>, target: number) => {
  const total = curveLength(curve);
  if (!total) {
    return 0;
  }
  let min = 0;
  let max = 1;
  for (let index = 0; index < 20; index++) {
    const candidate = (min + max) / 2;
    if (curveLengthAtParameter(curve, candidate) < target) {
      min = candidate;
    } else {
      max = candidate;
    }
  }
  return (min + max) / 2;
};

/** Finds the arc-length midpoint of the actual rendered linear path. */
export const getLineTonePathAnchor = (
  element: ExcalidrawLinearElement,
  elementsMap: ElementsMap,
): LineTonePathAnchor | null => {
  const shape = getElementShape<GlobalPoint>(element, elementsMap);
  if (shape.type !== "polycurve" || !shape.data.length) {
    return null;
  }

  const lengths = shape.data.map(curveLength);
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (!totalLength) {
    return null;
  }

  let remaining = totalLength / 2;
  let curveIndex = 0;
  while (curveIndex < lengths.length - 1 && remaining > lengths[curveIndex]) {
    remaining -= lengths[curveIndex];
    curveIndex++;
  }

  const curve = shape.data[curveIndex];
  const t = parameterAtLength(curve, remaining);
  const tangentVector = curveTangent(curve, t);
  const magnitude = Math.hypot(tangentVector[0], tangentVector[1]);
  if (!magnitude) {
    return null;
  }
  const tangent = [
    tangentVector[0] / magnitude,
    tangentVector[1] / magnitude,
  ] as const;

  return {
    point: pointFrom<GlobalPoint>(
      // inline Bezier evaluation via the public helper would duplicate its
      // generic branding here, so interpolate at the solved parameter.
      (1 - t) ** 3 * curve[0][0] +
        3 * (1 - t) ** 2 * t * curve[1][0] +
        3 * (1 - t) * t ** 2 * curve[2][0] +
        t ** 3 * curve[3][0],
      (1 - t) ** 3 * curve[0][1] +
        3 * (1 - t) ** 2 * t * curve[1][1] +
        3 * (1 - t) * t ** 2 * curve[2][1] +
        t ** 3 * curve[3][1],
    ),
    tangent,
    normal: [-tangent[1], tangent[0]],
  };
};

export type LineToneMarkerGeometry = {
  paths: readonly (readonly (readonly [number, number])[])[];
  circles?: readonly { center: readonly [number, number]; radius: number }[];
};

/** Marker coordinates normalized to a 16x16 box centered on the origin. */
export const getLineToneMarkerGeometry = (
  tone: LineTone,
): LineToneMarkerGeometry => {
  switch (tone) {
    case "certain":
      return {
        paths: [
          [
            [-6, 0],
            [-2, 4],
            [6, -5],
          ],
        ],
      };
    case "possible":
      return {
        paths: [
          [
            [-7, 1],
            [-4, -2],
            [-1, 1],
            [2, 4],
            [5, 1],
            [7, -1],
          ],
        ],
      };
    case "blocked":
      return {
        paths: [
          [
            [-5, -5],
            [5, 5],
          ],
          [
            [5, -5],
            [-5, 5],
          ],
        ],
      };
    case "questioned":
      return {
        paths: [
          [
            [-4, -3],
            [-3, -6],
            [0, -7],
            [4, -5],
            [4, -2],
            [0, 1],
            [0, 3],
          ],
        ],
        circles: [{ center: [0, 6], radius: 1 }],
      };
  }
};
