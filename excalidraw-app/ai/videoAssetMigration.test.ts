import { newEmbeddableElement, newTextElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  classifyAIVideoPortability,
  createAIVideoMigrationSnapshot,
  hasNonPortableAIVideo,
  omitAIVideoMarkersForInitialCloudSave,
  replaceAIVideoAssetIfCurrent,
  sanitizeDeletedAIVideoMarkersForPersistence,
} from "./videoAssetMigration";
import { buildAIVideoAssetLink } from "./videoCanvas";

import type {
  AIVideoGenerationMetadataV1,
  AIVideoGenerationMetadataV2,
} from "./types";

const baseMetadata = {
  kind: "video" as const,
  mode: "text-to-video" as const,
  model: "video-model",
  prompt: "waves",
  params: { size: "1280x720", n: 1 },
  mimeType: "video/mp4",
  createdAt: "2026-07-12T00:00:00.000Z",
};

const legacyMetadata: AIVideoGenerationMetadataV1 = {
  ...baseMetadata,
  version: 1,
  videoURL: "https://cdn.example.com/video.mp4?signature=secret",
};

const assetMetadata = (assetId: string): AIVideoGenerationMetadataV2 => ({
  ...baseMetadata,
  version: 2,
  assetId,
});

const videoElement = (
  metadata: AIVideoGenerationMetadataV1 | AIVideoGenerationMetadataV2,
) =>
  newEmbeddableElement({
    type: "embeddable",
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    link:
      metadata.version === 1
        ? metadata.videoURL
        : buildAIVideoAssetLink(metadata.assetId),
    customData: { aiVideoGeneration: metadata },
  });

describe("classifyAIVideoPortability", () => {
  it("distinguishes legacy URLs, local assets, and portable assets", () => {
    expect(classifyAIVideoPortability(videoElement(legacyMetadata)).kind).toBe(
      "legacy-v1-url",
    );
    expect(
      classifyAIVideoPortability(videoElement(assetMetadata("local:task-1")))
        .kind,
    ).toBe("local-v2");
    expect(
      classifyAIVideoPortability(videoElement(assetMetadata("asset-1"))).kind,
    ).toBe("portable-v2");
  });

  it("rejects non-video elements and mismatched links", () => {
    expect(
      classifyAIVideoPortability(newTextElement({ text: "hello", x: 0, y: 0 }))
        .kind,
    ).toBe("not-ai-video");

    const element = {
      ...videoElement(assetMetadata("asset-1")),
      link: buildAIVideoAssetLink("asset-2"),
    };
    expect(classifyAIVideoPortability(element).kind).toBe("invalid-marker");
  });

  it("fails closed when a malformed marker is paired with a signed URL", () => {
    const element = {
      ...videoElement(assetMetadata("asset-1")),
      link: "https://cdn.example.com/video.mp4?signature=must-not-leak",
      customData: {
        aiVideoGeneration: {
          version: 2,
          kind: "video",
          assetId: "asset-1",
        },
      },
    } as ExcalidrawElement;

    expect(classifyAIVideoPortability(element)).toEqual({
      kind: "invalid-marker",
    });
    expect(hasNonPortableAIVideo([element])).toBe(true);
    expect(createAIVideoMigrationSnapshot(element, "owner:scene-1")).toBeNull();
  });
});

describe("sanitizeDeletedAIVideoMarkersForPersistence", () => {
  it("strips the link and marker from deleted persistence copies", () => {
    const element = {
      ...videoElement(legacyMetadata),
      isDeleted: true,
      customData: {
        aiVideoGeneration: legacyMetadata,
        productTag: "keep-me",
      },
    } as ExcalidrawElement;

    const elements = [element];
    const sanitized = sanitizeDeletedAIVideoMarkersForPersistence(elements);

    expect(sanitized).not.toBe(elements);
    expect(sanitized[0]).not.toBe(element);
    expect(sanitized[0].link).toBeNull();
    expect(sanitized[0].customData).toEqual({ productTag: "keep-me" });
    expect(element.link).toBe(legacyMetadata.videoURL);
    expect(element.customData).toHaveProperty("aiVideoGeneration");
    expect(hasNonPortableAIVideo(sanitized)).toBe(false);
  });

  it("preserves the original array when no deleted marker needs sanitizing", () => {
    const element = videoElement(assetMetadata("asset-1"));
    const elements = [element];

    expect(sanitizeDeletedAIVideoMarkersForPersistence(elements)).toBe(
      elements,
    );
  });
});

describe("omitAIVideoMarkersForInitialCloudSave", () => {
  it("keeps the provisional payload free of local, legacy, portable, and malformed AI video references", () => {
    const ordinary = newTextElement({ text: "keep", x: 0, y: 0 });
    const malformed = {
      ...videoElement(assetMetadata("asset-1")),
      link: "https://cdn.example.com/video.mp4?signature=must-not-leak",
      customData: { aiVideoGeneration: { kind: "video", version: 2 } },
    } as ExcalidrawElement;
    const elements = [
      ordinary,
      videoElement(legacyMetadata),
      videoElement(assetMetadata("local:task-1")),
      videoElement(assetMetadata("asset-1")),
      malformed,
    ];

    const staged = omitAIVideoMarkersForInitialCloudSave(elements);

    expect(staged).toEqual([ordinary]);
    expect(elements).toHaveLength(5);
    expect(JSON.stringify(staged)).not.toContain("signature");
    expect(JSON.stringify(staged)).not.toContain("local:task-1");
  });
});
describe("replaceAIVideoAssetIfCurrent", () => {
  it("atomically replaces the matching element and preserves other custom data", () => {
    const element = {
      ...videoElement(legacyMetadata),
      customData: {
        aiVideoGeneration: legacyMetadata,
        productTag: "keep-me",
      },
    } as ExcalidrawElement;
    const snapshot = createAIVideoMigrationSnapshot(element, "owner:scene-1")!;
    const nextMetadata = assetMetadata("asset-1");

    const result = replaceAIVideoAssetIfCurrent({
      elements: [element],
      snapshot,
      currentContextToken: "owner:scene-1",
      metadata: nextMetadata,
    });

    expect(result.didReplace).toBe(true);
    expect(result.elements[0]).not.toBe(element);
    expect(result.elements[0].link).toBe(buildAIVideoAssetLink("asset-1"));
    expect(result.elements[0].customData).toEqual({
      productTag: "keep-me",
      aiVideoGeneration: nextMetadata,
    });
  });

  it.each<
    [
      string,
      {
        contextToken?: string;
        version?: number;
        link?: string;
        metadata?: AIVideoGenerationMetadataV1;
      },
    ]
  >([
    ["context", { contextToken: "owner:scene-2" }],
    ["version", { version: 99 }],
    ["link", { link: "https://cdn.example.com/changed.mp4" }],
    ["metadata", { metadata: { ...legacyMetadata, prompt: "changed" } }],
  ])("rejects a stale %s", (_label, change) => {
    const element = videoElement(legacyMetadata);
    const snapshot = createAIVideoMigrationSnapshot(element, "owner:scene-1")!;
    const current = {
      ...element,
      ...(change.version === undefined ? {} : { version: change.version }),
      ...(change.link === undefined ? {} : { link: change.link }),
      ...(change.metadata === undefined
        ? {}
        : {
            customData: {
              ...element.customData,
              aiVideoGeneration: change.metadata,
            },
          }),
    };

    const result = replaceAIVideoAssetIfCurrent({
      elements: [current],
      snapshot,
      currentContextToken: change.contextToken ?? "owner:scene-1",
      metadata: assetMetadata("asset-1"),
    });

    expect(result).toEqual({ elements: [current], didReplace: false });
  });
});
