import type { FileId } from "@excalidraw/element/types";
import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  createGeneratedAssetReferenceSource,
  getGeneratedAssetActionLabels,
  getGeneratedAssetDownloadFileName,
  getGeneratedAssetModeLabel,
  getGeneratedAssetReferenceFileName,
  isLocalImageDataURL,
} from "./AIImageWorkbenchAssets";

import type { GeneratedAsset } from "./AIImageWorkbenchAssets";

const createGeneratedAsset = (
  overrides: Partial<GeneratedAsset> = {},
): GeneratedAsset => ({
  id: "generated-asset-1",
  output: {
    dataURL: "data:image/png;base64,ZmFrZQ==" as DataURL,
    mimeType: "image/png",
  },
  metadata: {
    version: 1,
    kind: "image",
    mode: "text-to-image",
    model: "gpt-image-test",
    prompt: "A reusable generated concept",
    params: {
      size: "1024x1024",
      n: 1,
      seed: null,
      quality: "auto",
      style: "",
      referenceStrength: 0.6,
      duration: 5,
      fps: 24,
      resolution: "auto",
      aspectRatio: "auto",
      audioFormat: "mp3",
      voice: "",
    },
    sourceElementIds: [],
    output: {
      provider: "openai-compatible",
      index: 0,
      mimeType: "image/png",
    },
    createdAt: "2026-06-18T00:00:00.000Z",
  },
  insertedElementId: "generated-element",
  insertedFileId: "generated-file" as FileId,
  width: 640,
  height: 480,
  createdAt: "2026-06-18T00:00:00.000Z",
  index: 0,
  modelLabel: "GPT Image Test",
  siteName: "Example Provider",
  ...overrides,
});

describe("AIImageWorkbenchAssets", () => {
  it("creates locked reference sources from generated local image assets", () => {
    const source = createGeneratedAssetReferenceSource(
      createGeneratedAsset(),
      1781740000000,
    );

    expect(source).toMatchObject({
      elementId: "generated-element",
      elementIds: ["generated-element"],
      fileId: "generated-file",
      dataURL: "data:image/png;base64,ZmFrZQ==",
      width: 640,
      height: 480,
      sourceType: "imported",
      locked: true,
      createdAt: 1781740000000,
    });
    expect(source?.file.name).toBe(
      "ai-generated-reference-1781740000000-1.png",
    );
    expect(source?.file.type).toBe("image/png");
  });

  it("rejects remote generated image URLs as reference sources", () => {
    const source = createGeneratedAssetReferenceSource(
      createGeneratedAsset({
        output: {
          dataURL: "https://cdn.example.test/generated.png" as DataURL,
          mimeType: "image/png",
          remoteURL: "https://cdn.example.test/generated.png",
          storageType: "remote-url",
        },
      }),
      1781740000000,
    );

    expect(source).toBeNull();
    expect(isLocalImageDataURL("https://cdn.example.test/generated.png")).toBe(
      false,
    );
  });

  it("formats generated asset labels and reference file extensions", () => {
    expect(getGeneratedAssetModeLabel("text-to-image")).toBe("Text-to-image");
    expect(getGeneratedAssetModeLabel("image-to-image")).toBe("Reference");
    expect(getGeneratedAssetModeLabel("inpaint")).toBe("Inpaint");
    expect(
      getGeneratedAssetReferenceFileName(
        createGeneratedAsset({
          output: {
            dataURL: "data:image/webp;base64,ZmFrZQ==" as DataURL,
            mimeType: "image/webp",
          },
          index: 2,
        }),
        1781740000000,
      ),
    ).toBe("ai-generated-reference-1781740000000-3.webp");
  });

  it("creates complete generated asset action labels", () => {
    expect(getGeneratedAssetActionLabels(createGeneratedAsset())).toEqual({
      insert: "Insert generated asset #1 into canvas",
      useAsReference: "Use generated asset #1 as reference",
      reuseSettings: "Reuse generation settings from generated asset #1",
      copyPrompt: "Copy prompt from generated asset #1",
      download: "Download generated asset #1",
    });
  });

  it("builds download file names from the asset index and mime type", () => {
    expect(getGeneratedAssetDownloadFileName(createGeneratedAsset())).toBe(
      "ai-generated-1.png",
    );
    expect(
      getGeneratedAssetDownloadFileName(
        createGeneratedAsset({
          output: {
            dataURL: "data:image/webp;base64,ZmFrZQ==" as DataURL,
            mimeType: "image/webp",
          },
          index: 2,
        }),
      ),
    ).toBe("ai-generated-3.webp");
  });
});
