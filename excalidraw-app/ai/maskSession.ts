import { newFreeDrawElement } from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";
import type { LocalPoint, Radians } from "@excalidraw/math";

import { getMaskDrawingConfig } from "./maskCanvas";

export type AIMaskSession = {
  elements: ExcalidrawFreeDrawElement[];
  undoStack: ExcalidrawFreeDrawElement[][];
  redoStack: ExcalidrawFreeDrawElement[][];
  activeElementId: string | null;
};

export const createAIMaskSession = (
  elements: readonly ExcalidrawFreeDrawElement[] = [],
): AIMaskSession => ({
  elements: cloneMaskElements(elements),
  undoStack: [],
  redoStack: [],
  activeElementId: null,
});

export const beginAIMaskStroke = (
  session: AIMaskSession,
  {
    sceneX,
    sceneY,
    isErasing,
    brushSize,
  }: {
    sceneX: number;
    sceneY: number;
    isErasing: boolean;
    brushSize: number;
  },
): AIMaskSession => {
  const config = getMaskDrawingConfig(isErasing);
  const element = newFreeDrawElement({
    type: "freedraw",
    x: sceneX,
    y: sceneY,
    width: 0,
    height: 0,
    angle: 0 as Radians,
    strokeColor: config.strokeColor,
    backgroundColor: config.backgroundColor,
    fillStyle: "hachure",
    strokeWidth: brushSize,
    strokeStyle: config.strokeStyle,
    roughness: config.roughness,
    opacity: config.opacity,
    roundness: null,
    simulatePressure: true,
    locked: false,
    frameId: null,
    points: [pointFrom<LocalPoint>(0, 0)],
    pressures: [],
  });

  return {
    elements: [...session.elements, element],
    undoStack: [...session.undoStack, cloneMaskElements(session.elements)],
    redoStack: [],
    activeElementId: element.id,
  };
};

export const appendAIMaskStrokePoint = (
  session: AIMaskSession,
  sceneX: number,
  sceneY: number,
): AIMaskSession => {
  if (!session.activeElementId) {
    return session;
  }

  let didChange = false;
  const elements = session.elements.map((element) => {
    if (element.id !== session.activeElementId) {
      return element;
    }

    const scenePoints = element.points.map(
      (point) => [element.x + point[0], element.y + point[1]] as const,
    );
    const lastPoint = scenePoints[scenePoints.length - 1];

    if (lastPoint?.[0] === sceneX && lastPoint?.[1] === sceneY) {
      return element;
    }

    didChange = true;
    const nextScenePoints = [...scenePoints, [sceneX, sceneY] as const];
    const minX = Math.min(...nextScenePoints.map((point) => point[0]));
    const minY = Math.min(...nextScenePoints.map((point) => point[1]));
    const maxX = Math.max(...nextScenePoints.map((point) => point[0]));
    const maxY = Math.max(...nextScenePoints.map((point) => point[1]));

    return {
      ...element,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      points: nextScenePoints.map((point) =>
        pointFrom<LocalPoint>(point[0] - minX, point[1] - minY),
      ),
    };
  });

  return didChange ? { ...session, elements } : session;
};

export const endAIMaskStroke = (session: AIMaskSession): AIMaskSession =>
  session.activeElementId ? { ...session, activeElementId: null } : session;

export const undoAIMaskSession = (session: AIMaskSession): AIMaskSession => {
  const previous = session.undoStack[session.undoStack.length - 1];

  if (!previous) {
    return session;
  }

  return {
    elements: cloneMaskElements(previous),
    undoStack: session.undoStack.slice(0, -1),
    redoStack: [...session.redoStack, cloneMaskElements(session.elements)],
    activeElementId: null,
  };
};

export const redoAIMaskSession = (session: AIMaskSession): AIMaskSession => {
  const next = session.redoStack[session.redoStack.length - 1];

  if (!next) {
    return session;
  }

  return {
    elements: cloneMaskElements(next),
    undoStack: [...session.undoStack, cloneMaskElements(session.elements)],
    redoStack: session.redoStack.slice(0, -1),
    activeElementId: null,
  };
};

const cloneMaskElements = (
  elements: readonly ExcalidrawFreeDrawElement[],
): ExcalidrawFreeDrawElement[] =>
  elements.map((element) => ({
    ...element,
    groupIds: [...element.groupIds],
    boundElements: element.boundElements ? [...element.boundElements] : null,
    points: element.points.map((point) =>
      pointFrom<LocalPoint>(point[0], point[1]),
    ),
    pressures: [...element.pressures],
    customData: element.customData ? { ...element.customData } : undefined,
  }));
