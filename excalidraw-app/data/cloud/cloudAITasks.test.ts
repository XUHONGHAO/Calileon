import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { recordCloudAITask } from "./cloudAITasks";

import type { CloudBackend } from "./types";

const imageDataURL = "data:image/png;base64,aW1hZ2U=" as DataURL;

const makeBackend = (overrides: Partial<CloudBackend> = {}): CloudBackend =>
  ({
    capabilities: {
      aiTasks: true,
      assetStorage: true,
    },
    assets: {
      listByScene: vi.fn(async () => []),
      upload: vi.fn(async (input) => ({
        id: `asset-${input.fileId}`,
        ownerId: "owner-1",
        sceneId: input.sceneId ?? null,
        fileId: input.fileId,
        type: input.type,
        url: "https://signed.example/asset",
        bytes: input.blob.size,
        createdAt: 1,
      })),
    },
    aiTasks: {
      create: vi.fn(async (input) => ({
        id: "task-1",
        ownerId: "owner-1",
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        ...input,
      })),
      list: vi.fn(),
      remove: vi.fn(),
    },
    ...overrides,
  } as unknown as CloudBackend);

const baseRun = {
  submittedAt: "2026-06-23T01:00:00.000Z",
  completedAt: "2026-06-23T01:00:02.000Z",
  mediaType: "image" as const,
  mode: "text-to-image" as const,
  status: "success" as const,
  model: {
    id: "model-card-1",
    name: "image-model",
    siteName: "Provider",
  },
  prompt: "api key: should-not-persist, draw a diagram",
  params: {
    size: "1024x1024",
    n: 1,
  },
};

describe("recordCloudAITask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips when no active cloud scene is bound", async () => {
    const backend = makeBackend();

    await recordCloudAITask({
      backend,
      sceneId: null,
      run: baseRun,
    });

    expect(backend.aiTasks.create).not.toHaveBeenCalled();
    expect(backend.assets.upload).not.toHaveBeenCalled();
  });

  it("uploads successful generated outputs as ai-output assets", async () => {
    const backend = makeBackend();

    await recordCloudAITask({
      backend,
      sceneId: "scene-1",
      run: {
        ...baseRun,
        outputs: [
          {
            output: {
              dataURL: imageDataURL,
              mimeType: "image/png",
            },
            insertedElementId: "element-1",
            insertedFileId: "file-1" as FileId,
          },
        ],
      },
    });

    expect(backend.assets.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai-output",
        sceneId: "scene-1",
        fileId: "file-1",
      }),
    );
    expect(backend.aiTasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: "scene-1",
        status: "succeeded",
        outputAssetIds: ["asset-file-1"],
        insertedElementIds: ["element-1"],
        promptSummary: expect.stringContaining("[redacted]"),
      }),
    );
  });

  it("reuses existing input assets before uploading reference sources", async () => {
    const backend = makeBackend();
    vi.mocked(backend.assets.listByScene).mockResolvedValue([
      {
        id: "asset-source",
        ownerId: "owner-1",
        sceneId: "scene-1",
        fileId: "source-file",
        type: "ai-output",
        url: "https://signed.example/source",
        bytes: 10,
        createdAt: 1,
      },
    ]);

    await recordCloudAITask({
      backend,
      sceneId: "scene-1",
      run: {
        ...baseRun,
        mode: "image-to-image",
        sources: [
          {
            elementId: "source-element",
            fileId: "source-file" as FileId,
            file: new File(["source"], "source.png", { type: "image/png" }),
            dataURL: imageDataURL,
          },
        ],
      },
    });

    expect(backend.assets.upload).not.toHaveBeenCalled();
    expect(backend.aiTasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        inputAssetIds: ["asset-source"],
        sourceElementIds: ["source-element"],
      }),
    );
  });

  it("records failed runs without uploading output assets", async () => {
    const backend = makeBackend();

    await recordCloudAITask({
      backend,
      sceneId: "scene-1",
      run: {
        ...baseRun,
        status: "failed",
        errorCode: "auth",
        errorMessage: "Authorization: secret-token failed",
      },
    });

    expect(backend.assets.upload).not.toHaveBeenCalled();
    expect(backend.aiTasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        outputAssetIds: [],
        errorCode: "auth",
        errorMessage: expect.stringContaining("[redacted]"),
      }),
    );
  });
});
