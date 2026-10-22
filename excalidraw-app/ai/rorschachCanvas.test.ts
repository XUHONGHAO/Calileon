import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRorschachInsertPosition,
  insertRorschachResultIntoCanvas,
  wrapRorschachReading,
} from "./rorschachCanvas";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const api = (elements: any[] = []) => ({
  getSceneElements: vi.fn(() => elements),
  getAppState: vi.fn(() => ({
    selectedElementIds: {},
    width: 1000,
    height: 700,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  })),
  addFiles: vi.fn(),
  updateScene: vi.fn(),
});

const relation = {
  persona: "gentleCounselor",
  reading: "我看到一只想飞的鸟",
  sourceElementIds: ["scribble-1"],
  batchId: "rorschach-1",
};

/** jsdom never decodes images, so fake a 400x400 load. */
class MockRorschachImage {
  public naturalWidth = 400;
  public naturalHeight = 400;
  public width = 400;
  public height = 400;
  public onload: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public set src(_value: string) {
    queueMicrotask(() => this.onload?.(new Event("load")));
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", MockRorschachImage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rorschachCanvas", () => {
  it("writes the image and the reading in ONE captured scene update", async () => {
    const source = {
      id: "scribble-1",
      type: "freedraw",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      isDeleted: false,
    } as any;
    const excalidrawAPI = api([source]);

    const result = await insertRorschachResultIntoCanvas({
      excalidrawAPI: excalidrawAPI as any,
      relation,
      imageOutput: { dataURL: PNG, mimeType: "image/png" },
      reading: relation.reading,
      sourceBounds: { x: 100, y: 100, width: 300, height: 200 },
    });

    expect(excalidrawAPI.updateScene).toHaveBeenCalledTimes(1);
    expect(excalidrawAPI.addFiles).toHaveBeenCalledTimes(1);
    const call = excalidrawAPI.updateScene.mock.calls[0][0] as any;
    expect(call.captureUpdate).toBe(CaptureUpdateAction.IMMEDIATELY);

    const inserted = call.elements.slice(1);
    expect(inserted).toHaveLength(2);
    expect(inserted[0].type).toBe("image");
    expect(inserted[1].type).toBe("text");
    // Same group => one click selects both, one undo removes both.
    expect(new Set(inserted[0].groupIds)).toEqual(
      new Set(inserted[1].groupIds),
    );
    expect(inserted[0].groupIds[0]).toBeTruthy();
    // Both are selected after insert.
    expect(Object.keys(call.appState.selectedElementIds)).toHaveLength(2);
    // The reading is stored on both elements, the prompt never is.
    expect(inserted[0].customData.rorschach).toEqual(relation);
    expect(inserted[1].customData.rorschach).toEqual(relation);
    expect(JSON.stringify(inserted)).not.toContain("imagePrompt");
    // Placed to the right of the scribble, not on top of it.
    expect(inserted[0].x).toBeGreaterThan(source.x + source.width);
    expect(result?.imageElement?.id).toBe(inserted[0].id);
  });

  it("inserts only the sentence when no image is available", async () => {
    const excalidrawAPI = api([]);

    const result = await insertRorschachResultIntoCanvas({
      excalidrawAPI: excalidrawAPI as any,
      relation,
      imageOutput: null,
      reading: relation.reading,
      sourceBounds: null,
    });

    const call = excalidrawAPI.updateScene.mock.calls[0][0] as any;
    expect(call.elements).toHaveLength(1);
    expect(call.elements[0].type).toBe("text");
    expect(excalidrawAPI.addFiles).not.toHaveBeenCalled();
    expect(result?.imageElement).toBeNull();
  });

  it("never persists secrets, URLs or model prompts on the elements", async () => {
    const excalidrawAPI = api([]);

    await insertRorschachResultIntoCanvas({
      excalidrawAPI: excalidrawAPI as any,
      relation: {
        persona: "grimDiviner",
        reading: "看到 https://signed.example.test/a.png?token=1",
        sourceElementIds: ["scribble-1", "Bearer sk-secret"],
        batchId: "batch-1",
      },
      imageOutput: { dataURL: PNG, mimeType: "image/png" },
      reading: "我看到一只鸟",
      sourceBounds: null,
    });

    const call = excalidrawAPI.updateScene.mock.calls[0][0] as any;
    const serialized = JSON.stringify(call.elements);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("imagePrompt");
    expect(serialized).not.toContain("apiKey");
    // The portable relation is still readable and whitelisted.
    const relation = call.elements[0].customData.rorschach;
    expect(relation.persona).toBe("grimDiviner");
    expect(relation.reading).toBe("");
    expect(relation.sourceElementIds).toEqual(["scribble-1"]);
  });

  it("refuses remote URLs as scene assets", async () => {
    const excalidrawAPI = api([]);

    const result = await insertRorschachResultIntoCanvas({
      excalidrawAPI: excalidrawAPI as any,
      relation,
      imageOutput: {
        dataURL: "https://example.test/a.png",
        mimeType: "image/png",
      },
      reading: null,
      sourceBounds: null,
    });

    expect(result).toBeNull();
    expect(excalidrawAPI.updateScene).not.toHaveBeenCalled();
  });

  it("does nothing when there is neither image nor reading", async () => {
    const excalidrawAPI = api([]);
    await expect(
      insertRorschachResultIntoCanvas({
        excalidrawAPI: excalidrawAPI as any,
        relation,
        imageOutput: null,
        reading: null,
        sourceBounds: null,
      }),
    ).resolves.toBeNull();
    expect(excalidrawAPI.updateScene).not.toHaveBeenCalled();
  });

  it("aborts before writing anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const excalidrawAPI = api([]);

    await expect(
      insertRorschachResultIntoCanvas({
        excalidrawAPI: excalidrawAPI as any,
        relation,
        imageOutput: { dataURL: PNG, mimeType: "image/png" },
        reading: relation.reading,
        sourceBounds: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(excalidrawAPI.updateScene).not.toHaveBeenCalled();
  });

  it("keeps the new output clear of existing elements", () => {
    const blocker = {
      id: "blocker",
      type: "rectangle",
      x: 424,
      y: 100,
      width: 400,
      height: 400,
      isDeleted: false,
    } as any;

    const position = getRorschachInsertPosition({
      size: { width: 200, height: 200 },
      sourceBounds: { x: 100, y: 100, width: 300, height: 200 },
      sceneElements: [blocker],
    });

    expect(position.x).toBeGreaterThanOrEqual(blocker.x + blocker.width);
    expect(position.y).toBe(100);
  });

  it("wraps long readings under the picture width", () => {
    const chinese = "我看到一个想逃跑的人但他的脚被钉在了地上".repeat(3);
    const wrapped = wrapRorschachReading(chinese, 240);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);

    const english =
      "I see a small bird that wants to fly away but keeps circling the same corner";
    const wrappedEnglish = wrapRorschachReading(english, 200);
    expect(wrappedEnglish.split("\n").length).toBeGreaterThan(1);
    expect(wrappedEnglish.replace(/\n/g, " ")).toBe(english);
  });
});
