import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import {
  getReferencedFileIds,
  loadSceneAssets,
  uploadSceneAssets,
} from "./cloudAssets";

import type { CloudBackend } from "./types";

const makeBackend = (): CloudBackend =>
  ({
    capabilities: { assetStorage: true },
    assets: {
      upload: vi.fn().mockResolvedValue({ id: "asset-1" }),
      listByScene: vi.fn().mockResolvedValue([]),
    },
  } as unknown as CloudBackend);

const imageElement = (fileId: string, isDeleted = false, customData?: any) =>
  ({
    id: `element-${fileId}`,
    type: "image",
    fileId,
    isDeleted,
    customData,
  } as any);

const audioElement = (fileId: string, isDeleted = false) =>
  ({
    id: `element-${fileId}`,
    type: "audio",
    fileId,
    isDeleted,
  } as any);

describe("cloudAssets", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob(["image"], { type: "image/png" })),
        ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads only image files referenced by non-deleted scene elements", async () => {
    const backend = makeBackend();
    const files: BinaryFiles = {
      "file-1": {
        id: "file-1" as FileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aW1hZ2U=" as DataURL,
        created: 1,
      },
      unused: {
        id: "unused" as FileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,dW51c2Vk" as DataURL,
        created: 1,
      },
    };

    await uploadSceneAssets({
      backend,
      sceneId: "scene-1",
      elements: [imageElement("file-1"), imageElement("unused", true)],
      files,
    });

    expect(backend.assets.upload).toHaveBeenCalledTimes(1);
    expect(backend.assets.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        sceneId: "scene-1",
        fileId: "file-1",
        mimeType: "image/png",
      }),
    );
  });

  it("uploads AI generated image elements as ai-output assets", async () => {
    const backend = makeBackend();
    const files: BinaryFiles = {
      "file-1": {
        id: "file-1" as FileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aW1hZ2U=" as DataURL,
        created: 1,
      },
    };

    await uploadSceneAssets({
      backend,
      sceneId: "scene-1",
      elements: [
        imageElement("file-1", false, {
          aiGeneration: { kind: "image" },
        }),
      ],
      files,
    });

    expect(backend.assets.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai-output",
        sceneId: "scene-1",
        fileId: "file-1",
      }),
    );
  });

  it("uploads voice message files as audio assets (ADR 0034)", async () => {
    const backend = makeBackend();
    const files: BinaryFiles = {
      "voice-1": {
        id: "voice-1" as FileId,
        mimeType: "audio/webm",
        dataURL: "data:audio/webm;codecs=opus;base64,dm9pY2U=" as DataURL,
        created: 1,
      },
    };

    await uploadSceneAssets({
      backend,
      sceneId: "scene-1",
      elements: [audioElement("voice-1")],
      files,
    });

    expect(backend.assets.upload).toHaveBeenCalledTimes(1);
    expect(backend.assets.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "audio",
        fileId: "voice-1",
        mimeType: "audio/webm",
      }),
    );
  });

  it("references audio files so they are fetched back and kept", () => {
    expect(
      getReferencedFileIds([
        imageElement("image-1"),
        audioElement("voice-1"),
        audioElement("voice-deleted", true),
        { id: "r", type: "rectangle", isDeleted: false } as any,
      ]),
    ).toEqual(["image-1", "voice-1"]);
  });

  it("loads audio assets referenced by voice bubbles", async () => {
    const backend = makeBackend();
    vi.mocked(backend.assets.listByScene).mockResolvedValue([
      {
        id: "asset-2",
        ownerId: "owner-1",
        sceneId: "scene-1",
        fileId: "voice-1",
        type: "audio",
        url: "https://signed.example/voice-1",
        mimeType: "audio/webm",
        bytes: 5,
        createdAt: 1,
      },
    ]);

    const result = await loadSceneAssets({
      backend,
      sceneId: "scene-1",
      elements: [audioElement("voice-1")],
    });

    expect(result.loadedFiles).toHaveLength(1);
    expect(result.loadedFiles[0]).toMatchObject({
      id: "voice-1",
      mimeType: "audio/webm",
    });
    expect(result.erroredFiles.size).toBe(0);
  });

  it("restores remote asset URLs into BinaryFileData by fileId", async () => {
    const backend = makeBackend();
    vi.mocked(backend.assets.listByScene).mockResolvedValue([
      {
        id: "asset-1",
        ownerId: "owner-1",
        sceneId: "scene-1",
        fileId: "file-1",
        type: "image",
        url: "https://signed.example/file-1",
        mimeType: "image/png",
        bytes: 5,
        createdAt: 1,
      },
    ]);

    const result = await loadSceneAssets({
      backend,
      sceneId: "scene-1",
      elements: [imageElement("file-1")],
    });

    expect(result.loadedFiles).toHaveLength(1);
    expect(result.loadedFiles[0]).toMatchObject({
      id: "file-1",
      mimeType: "image/png",
      created: 1,
    });
    expect(result.loadedFiles[0].dataURL.startsWith("data:")).toBe(true);
    expect(result.erroredFiles.size).toBe(0);
  });
});
