import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newImageElement } from "@excalidraw/element";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getManyMindsGridColumnCount,
  insertManyMindsTasksIntoCanvas,
  replaceManyMindsSourceImage,
  sanitizeManyMindsPortableRelation,
} from "./manyMindsCanvas";

import type { ManyMindsCanvasItem } from "./manyMindsCanvas";

const PNG = "data:image/png;base64,iVBORw0KGgo=" as const;

const item = (id: string): ManyMindsCanvasItem => ({
  task: { id } as any,
  asset: {
    id: `asset-${id}`,
    dataURL: PNG,
    mimeType: "image/png",
    width: 200,
    height: 120,
  } as any,
  relation: {
    version: 1,
    batchId: "batch-1",
    taskId: id,
    perspectiveId: `perspective-${id}`,
    inputAssetIds: ["input-asset-1"],
    outputAssetId: `asset-${id}`,
  } as any,
});

const api = (elements: any[] = [], selectedElementIds = {}) => ({
  getSceneElements: vi.fn(() => elements),
  getAppState: vi.fn(() => ({
    selectedElementIds,
    width: 1000,
    height: 700,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  })),
  addFiles: vi.fn(),
  updateScene: vi.fn(),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Many Minds canvas", () => {
  it.each([
    [1, 1],
    [2, 2],
    [4, 2],
    [6, 3],
    [9, 3],
  ])("uses a stable grid for %i result(s)", (count, columns) => {
    expect(getManyMindsGridColumnCount(count)).toBe(columns);
  });

  it.each([2, 4, 6, 9])(
    "atomically inserts a non-overlapping %i-item grid to the right of the scene",
    async (count) => {
      const source = {
        id: "source-1",
        type: "rectangle",
        x: 40,
        y: 70,
        width: 300,
        height: 200,
        isDeleted: false,
      } as any;
      const excalidrawAPI = api([source], { "source-1": true });

      const inserted = await insertManyMindsTasksIntoCanvas({
        excalidrawAPI: excalidrawAPI as any,
        items: Array.from({ length: count }, (_, index) =>
          item(`task-${index}`),
        ),
        sourceElementIds: ["source-1"],
      });

      expect(excalidrawAPI.addFiles).toHaveBeenCalledTimes(1);
      expect(excalidrawAPI.updateScene).toHaveBeenCalledTimes(1);
      expect(inserted).toHaveLength(count);
      expect(
        inserted.every((element) => element.x > source.x + source.width),
      ).toBe(true);
      for (let left = 0; left < inserted.length; left++) {
        for (let right = left + 1; right < inserted.length; right++) {
          expect(overlaps(inserted[left], inserted[right])).toBe(false);
        }
      }
      expect(excalidrawAPI.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        }),
      );
    },
  );

  it("replaces an image payload while preserving geometry and creates one undo entry", async () => {
    const source = newImageElement({
      type: "image",
      x: 80,
      y: 90,
      width: 640,
      height: 360,
      fileId: "old-file" as any,
      status: "saved",
      angle: 0.25 as any,
      customData: { existing: true },
    }) as any;
    const excalidrawAPI = api([source], { [source.id]: true });

    const replacement = await replaceManyMindsSourceImage({
      excalidrawAPI: excalidrawAPI as any,
      item: item("replacement"),
      sourceElementId: source.id,
    });

    expect(replacement).toMatchObject({
      id: source.id,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
      angle: source.angle,
      customData: {
        existing: true,
        manyMinds: expect.objectContaining({ taskId: "replacement" }),
      },
    });
    expect(replacement.fileId).not.toBe(source.fileId);
    expect(excalidrawAPI.addFiles).toHaveBeenCalledTimes(1);
    expect(excalidrawAPI.updateScene).toHaveBeenCalledTimes(1);
    expect(excalidrawAPI.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
  });

  it("stores only the portable relation allowlist", () => {
    expect(
      sanitizeManyMindsPortableRelation({
        version: 1,
        batchId: "batch-1",
        taskId: "task-1",
        perspectiveId: "perspective-1",
        inputAssetIds: ["input-asset-1"],
        outputAssetId: "output-asset-1",
        apiKey: "secret",
        signedURL: "https://signed.example/output.png?token=secret",
      } as any),
    ).toEqual({
      version: 1,
      batchId: "batch-1",
      taskId: "task-1",
      perspectiveId: "perspective-1",
      inputAssetIds: ["input-asset-1"],
      outputAssetId: "output-asset-1",
    });
  });
});

const overlaps = (
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;
