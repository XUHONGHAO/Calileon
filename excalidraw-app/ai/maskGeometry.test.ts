import {
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { FileId } from "@excalidraw/element/types";
import type { NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { Radians } from "@excalidraw/math";

import {
  createMaskSourceGeometryV2,
  legacyDisplayPointToScenePoint,
  normalizedNaturalPointToScenePoint,
  scenePointToLegacyDisplayPoint,
  scenePointToNormalizedNaturalPoint,
} from "./maskGeometry";
import {
  createMaskViewportGeometry,
  isPointInMaskViewportGeometry,
} from "./maskViewportGeometry";

const FILE_ID = "mask-geometry-file" as FileId;

describe("mask source geometry", () => {
  it("preserves normalized natural pixels across crop and flip changes", () => {
    const source = createMaskSourceGeometryV2({
      ...createImage(),
      scale: [-1, 1],
      crop: {
        x: 100,
        y: 50,
        width: 200,
        height: 150,
        naturalWidth: 400,
        naturalHeight: 300,
      },
    });
    const target = createMaskSourceGeometryV2({
      ...createImage(),
      x: 300,
      y: 200,
      width: 300,
      height: 200,
      scale: [1, -1],
      crop: {
        x: 50,
        y: 0,
        width: 300,
        height: 240,
        naturalWidth: 400,
        naturalHeight: 300,
      },
    });
    const sourceScenePoint = [125, 100] as const;
    const naturalPoint = scenePointToNormalizedNaturalPoint(
      sourceScenePoint,
      source,
    );
    const targetScenePoint = normalizedNaturalPointToScenePoint(
      naturalPoint,
      target,
    );

    expect(naturalPoint[0]).toBeCloseTo(0.6875);
    expect(naturalPoint[1]).toBeCloseTo(1 / 3);
    const roundTrippedNaturalPoint = scenePointToNormalizedNaturalPoint(
      targetScenePoint,
      target,
    );
    expect(roundTrippedNaturalPoint[0]).toBeCloseTo(naturalPoint[0]);
    expect(roundTrippedNaturalPoint[1]).toBeCloseTo(naturalPoint[1]);
  });

  it("keeps the version 1 display-normalized compatibility mapping", () => {
    const source = {
      version: 1 as const,
      imageId: "image",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      angle: 0 as Radians,
    };
    const target = {
      ...source,
      x: 110,
      y: 120,
      width: 200,
      height: 160,
    };
    const normalized = scenePointToLegacyDisplayPoint([35, 60], source);

    expect(normalized).toEqual([0.25, 0.5]);
    expect(legacyDisplayPointToScenePoint(normalized, target)).toEqual([
      160, 200,
    ]);
  });

  it("maps 45-degree cropped double-flipped pixels through the overlay viewport", () => {
    const image = {
      ...createImage(),
      angle: (Math.PI / 4) as Radians,
      scale: [-1, -1] as [number, number],
      crop: {
        x: 80,
        y: 30,
        width: 240,
        height: 180,
        naturalWidth: 400,
        naturalHeight: 300,
      },
    };
    const source = createMaskSourceGeometryV2(image);
    const viewportState = {
      zoom: { value: 1.5 as NormalizedZoomValue },
      offsetLeft: 24,
      offsetTop: 36,
      scrollX: -12,
      scrollY: 8,
    };
    const center = sceneCoordsToViewportCoords(
      {
        sceneX: image.x + image.width / 2,
        sceneY: image.y + image.height / 2,
      },
      viewportState,
    );
    const overlay = createMaskViewportGeometry({
      centerX: center.x,
      centerY: center.y,
      width: image.width * viewportState.zoom.value,
      height: image.height * viewportState.zoom.value,
      angle: image.angle,
    });

    const cropBottomRightNatural = [0.8, 0.7] as const;
    const cropTopLeftNatural = [0.2, 0.1] as const;
    const bottomRightScene = normalizedNaturalPointToScenePoint(
      cropBottomRightNatural,
      source,
    );
    const topLeftScene = normalizedNaturalPointToScenePoint(
      cropTopLeftNatural,
      source,
    );
    const bottomRightViewport = sceneCoordsToViewportCoords(
      { sceneX: bottomRightScene[0], sceneY: bottomRightScene[1] },
      viewportState,
    );
    const topLeftViewport = sceneCoordsToViewportCoords(
      { sceneX: topLeftScene[0], sceneY: topLeftScene[1] },
      viewportState,
    );

    expect(bottomRightViewport.x).toBeCloseTo(overlay.corners[0][0]);
    expect(bottomRightViewport.y).toBeCloseTo(overlay.corners[0][1]);
    expect(topLeftViewport.x).toBeCloseTo(overlay.corners[2][0]);
    expect(topLeftViewport.y).toBeCloseTo(overlay.corners[2][1]);
    expect(
      isPointInMaskViewportGeometry(overlay, [
        (bottomRightViewport.x + overlay.centerX) / 2,
        (bottomRightViewport.y + overlay.centerY) / 2,
      ]),
    ).toBe(true);

    const roundTrippedScene = viewportCoordsToSceneCoords(
      {
        clientX: bottomRightViewport.x,
        clientY: bottomRightViewport.y,
      },
      viewportState,
    );
    const roundTrippedNatural = scenePointToNormalizedNaturalPoint(
      [roundTrippedScene.x, roundTrippedScene.y],
      source,
    );
    expect(roundTrippedNatural[0]).toBeCloseTo(cropBottomRightNatural[0]);
    expect(roundTrippedNatural[1]).toBeCloseTo(cropBottomRightNatural[1]);
  });
});

const createImage = () =>
  API.createElement({
    type: "image",
    id: "image",
    fileId: FILE_ID,
    x: 100,
    y: 50,
    width: 200,
    height: 150,
    status: "saved",
  });
