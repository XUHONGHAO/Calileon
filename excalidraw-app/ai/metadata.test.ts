import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  createAIImageGenerationMetadata,
  createAIVideoAssetMetadata,
  createAIVideoGenerationMetadata,
} from "./metadata";

describe("AI image metadata", () => {
  it("stores generation parameters without provider secrets", () => {
    const metadata = createAIImageGenerationMetadata({
      mode: "text-to-image",
      model: "gpt-image-1",
      prompt: "a quiet studio desk",
      negativePrompt: "blur",
      params: {
        size: "1024x1024",
        n: 1,
        seed: 42,
        quality: "auto",
      },
      sourceElementIds: [],
      output: {
        dataURL: "data:image/png;base64,AAA" as DataURL,
        mimeType: "image/png",
      },
      index: 0,
      createdAt: "2026-06-12T00:00:00.000Z",
    });

    expect(metadata).toMatchObject({
      version: 1,
      kind: "image",
      mode: "text-to-image",
      model: "gpt-image-1",
      prompt: "a quiet studio desk",
      negativePrompt: "blur",
      sourceElementIds: [],
      output: {
        provider: "openai-compatible",
        index: 0,
        mimeType: "image/png",
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("sk-");
    expect(JSON.stringify(metadata)).not.toContain("apiKey");
    expect(JSON.stringify(metadata)).not.toContain("Authorization");
  });

  it("removes signed query parameters from localized image metadata", () => {
    const metadata = createAIImageGenerationMetadata({
      mode: "text-to-image",
      model: "gpt-image-1",
      prompt: "a quiet studio desk",
      params: {
        size: "1024x1024",
        n: 1,
      },
      sourceElementIds: [],
      output: {
        dataURL: "data:image/png;base64,AAA" as DataURL,
        mimeType: "image/png",
        remoteURL:
          "https://user:password@account.blob.core.windows.net/container/out.png?sp=r&sig=sas-signature#preview",
      },
      index: 0,
    });

    expect(metadata.output.remoteURL).toBe(
      "https://account.blob.core.windows.net/container/out.png",
    );
    expect(JSON.stringify(metadata)).not.toContain("sas-signature");
    expect(JSON.stringify(metadata)).not.toContain("user:password");
  });

  it("stores video generation metadata with the real video URL", () => {
    const metadata = createAIVideoGenerationMetadata({
      mode: "text-to-video",
      model: "grok-video-3",
      prompt: "a cat listening to music",
      params: {
        size: "720P",
        n: 1,
        duration: 6,
        aspectRatio: "9:16",
      },
      output: {
        videoURL: "https://cdn.example.com/out.mp4?token=playback-token",
        mimeType: "video/mp4",
        durationSeconds: 6,
        revisedPrompt: "a fluffy cat listening to music",
      },
      createdAt: "2026-07-07T00:00:00.000Z",
    });

    expect(metadata).toMatchObject({
      version: 1,
      kind: "video",
      mode: "text-to-video",
      model: "grok-video-3",
      videoURL: "https://cdn.example.com/out.mp4?token=playback-token",
      mimeType: "video/mp4",
      durationSeconds: 6,
    });
  });

  it("stores v2 video metadata as a stable asset without the provider URL", () => {
    const metadata = createAIVideoAssetMetadata({
      mode: "text-to-video",
      model: "grok-video-3",
      prompt: "a cat listening to music",
      params: { size: "", n: 1, duration: 6 },
      asset: {
        assetId: "asset-stable-1",
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
        durationSeconds: 6,
      },
      createdAt: "2026-07-12T00:00:00.000Z",
    });

    expect(metadata).toMatchObject({
      version: 2,
      kind: "video",
      assetId: "asset-stable-1",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });
    expect(JSON.stringify(metadata)).not.toContain("videoURL");
    expect(JSON.stringify(metadata)).not.toContain("token=");
  });
});
