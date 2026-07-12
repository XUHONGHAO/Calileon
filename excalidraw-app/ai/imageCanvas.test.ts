import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGeneratedImagePosition,
  insertGeneratedImageIntoCanvas,
} from "./imageCanvas";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGeneratedImagePosition", () => {
  it("places reference-mode output to the right of the reference with top edges aligned", () => {
    const position = getGeneratedImagePosition(
      { width: 320, height: 240 },
      [],
      [
        {
          id: "reference-1",
          type: "image",
          x: 40,
          y: 42,
          width: 160,
          height: 90,
          isDeleted: false,
        } as any,
      ],
      {
        width: 1000,
        height: 700,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      } as any,
      {
        kind: "reference",
        elementIds: ["reference-1"],
      },
    );

    expect(position).toEqual({
      x: 216,
      y: 42,
    });
  });

  it("does not commit files or elements when aborted before canvas mutation", async () => {
    class LoadedImage {
      public naturalWidth = 320;
      public naturalHeight = 240;
      public width = 320;
      public height = 240;
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      public set src(_value: string) {
        this.onload?.();
      }
    }

    vi.stubGlobal("Image", LoadedImage);
    const controller = new AbortController();
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const excalidrawAPI = {
      getAppState: () => ({
        selectedElementIds: {},
        width: 1000,
        height: 700,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      }),
      getSceneElements: () => {
        controller.abort();
        return [];
      },
      addFiles,
      updateScene,
    } as any;

    await expect(
      insertGeneratedImageIntoCanvas({
        excalidrawAPI,
        output: {
          dataURL: "https://example.com/generated.png" as any,
          mimeType: "image/png",
          storageType: "remote-url",
        },
        metadata: {
          version: 1,
          kind: "image",
          mode: "text-to-image",
          model: "test-model",
          prompt: "test",
          params: {},
          sourceElementIds: [],
          output: {
            dataURL: "https://example.com/generated.png" as any,
            mimeType: "image/png",
          },
          createdAt: new Date().toISOString(),
        } as any,
        index: 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(addFiles).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
  });
});
