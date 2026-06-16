import type { DataURL } from "@excalidraw/excalidraw/types";

import { createAIImageGenerationMetadata } from "./metadata";

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
});
