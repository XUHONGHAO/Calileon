import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  appendAIGenerationLog,
  clearAIGenerationLogs,
  createAIGenerationLogEntry,
  createSuccessResponseDetails,
  loadAIGenerationLogs,
  sanitizeLogDetails,
} from "./generationLog";

describe("AI generation log", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and clears generation log entries", () => {
    const entry = createAIGenerationLogEntry({
      submittedAt: "2026-06-13T10:00:00.000Z",
      mediaType: "image",
      mode: "text-to-image",
      status: "failed",
      model: {
        id: "model-1",
        name: "gpt-image-2",
        siteName: "NewAPI",
      },
      prompt: "red square",
      params: {
        size: "1024x1024",
        n: 1,
      },
      baseURL: "https://api.example.com/v1",
      endpoint: "https://api.example.com/v1/images/generations",
      responseSummary: "Invalid URL",
      responseDetails: {
        error: {
          message: "Invalid URL",
          type: "invalid_request_error",
          code: "",
        },
      },
    });

    appendAIGenerationLog(entry);

    expect(loadAIGenerationLogs()).toEqual([entry]);

    clearAIGenerationLogs();
    expect(loadAIGenerationLogs()).toEqual([]);
  });

  it("keeps the async task poll endpoint with a readable placeholder", () => {
    const entry = createAIGenerationLogEntry({
      submittedAt: "2026-10-29T10:00:00.000Z",
      mediaType: "image",
      mode: "text-to-image",
      status: "success",
      model: { id: "m", name: "nano-banana-fast", siteName: "Right Code" },
      prompt: "red square",
      params: { size: "1024x1024", n: 1 },
      baseURL: "https://www.right.codes/draw",
      endpoint: "https://www.right.codes/draw/v1/images/generations",
      pollEndpoint: "https://www.right.codes/v1/tasks/{task_id}?token=secret",
      responseSummary: "ok",
      responseDetails: {},
    });

    expect(entry.request).toEqual({
      baseURL: "https://www.right.codes/draw",
      endpoint: "https://www.right.codes/draw/v1/images/generations",
      pollEndpoint: "https://www.right.codes/v1/tasks/{task_id}",
    });

    appendAIGenerationLog(entry);
    expect(loadAIGenerationLogs()[0].request).toEqual(entry.request);
  });

  it("redacts secrets and summarizes image data URLs", () => {
    expect(
      sanitizeLogDetails({
        apiKey: "sk-secret",
        authorization: "Bearer sk-secret",
        image: `data:image/png;base64,${"A".repeat(2000)}`,
      }),
    ).toEqual({
      apiKey: "[redacted]",
      authorization: "[redacted]",
      image: {
        kind: "data-url",
        length: 2022,
        preview: "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
  });

  it("removes credentials, query strings, and hashes from persisted URLs", () => {
    const entry = createAIGenerationLogEntry({
      submittedAt: "2026-07-11T10:00:00.000Z",
      mediaType: "video",
      mode: "text-to-video",
      status: "success",
      model: {
        id: "model-1",
        name: "video-model",
        siteName: "NewAPI",
      },
      prompt: "Use https://example.com/reference.png?token=prompt-token",
      params: {
        size: "720P",
        n: 1,
      },
      baseURL: "https://user:password@api.example.com/v1?token=base-token",
      endpoint:
        "https://api.example.com/v1/videos?X-Amz-Signature=endpoint-signature#result",
      responseSummary: "completed",
      responseDetails: {
        remoteURL:
          "https://user:password@cdn.example.com/images/out.png?X-Amz-Signature=image-signature#preview",
        videoURL: "https://cdn.example.com/videos/out.mp4?token=video-token",
        nested: [
          "https://account.blob.core.windows.net/container/out.mp4?sp=r&sig=sas-signature",
        ],
        prompt: "https://example.com/?token=prompt-token",
      },
    });

    appendAIGenerationLog(entry);

    const [persistedEntry] = loadAIGenerationLogs();
    expect(persistedEntry).toMatchObject({
      prompt: "Use https://example.com/reference.png?token=prompt-token",
      request: {
        baseURL: "https://api.example.com/v1",
        endpoint: "https://api.example.com/v1/videos",
      },
      response: {
        details: {
          remoteURL: "https://cdn.example.com/images/out.png",
          videoURL: "https://cdn.example.com/videos/out.mp4",
          nested: ["https://account.blob.core.windows.net/container/out.mp4"],
          prompt: "https://example.com/?token=prompt-token",
        },
      },
    });

    const persistedJSON = localStorage.getItem("excalidraw-ai-generation-logs");
    expect(persistedJSON).not.toContain("X-Amz-Signature");
    expect(persistedJSON).not.toContain("sas-signature");
    expect(persistedJSON).not.toContain("user:password");
    expect(persistedJSON).toContain("prompt-token");
  });

  it("sanitizes remote image URLs in success response details", () => {
    expect(
      createSuccessResponseDetails([
        {
          dataURL: "https://cdn.example.com/out.png" as DataURL,
          mimeType: "image/png",
          remoteURL:
            "https://cdn.example.com/out.png?X-Amz-Signature=signature",
          storageType: "remote-url",
        },
      ]),
    ).toMatchObject({
      outputs: [
        {
          remoteURL: "https://cdn.example.com/out.png",
        },
      ],
    });
  });

  it("redacts secret-like text that providers echo back in error bodies", () => {
    expect(
      sanitizeLogDetails({
        message: "The supplied key sk-abcdef1234567890 is invalid.",
        rawBody: "<pre>Authorization: Bearer abc.def-ghi_jkl</pre>",
        providerError: "bad key AIzaSyA1234567890abcdefghijklmn",
        size: "1024x1024",
      }),
    ).toEqual({
      message: "The supplied key [redacted] is invalid.",
      rawBody: "<pre>Authorization: [redacted]</pre>",
      providerError: "bad key [redacted]",
      size: "1024x1024",
    });
  });

  it("redacts secret-like text in the persisted response summary", () => {
    const entry = createAIGenerationLogEntry({
      submittedAt: "2026-10-28T10:00:00.000Z",
      mediaType: "image",
      mode: "text-to-image",
      status: "failed",
      model: { id: "m", name: "nano-banana-fast", siteName: "Right Code" },
      prompt: "cat",
      params: { size: "1:1", n: 1 },
      baseURL: "https://www.right.codes/draw",
      responseSummary: "Invalid key sk-abcdef1234567890",
      responseDetails: {},
    });

    expect(entry.response.summary).toBe("Invalid key [redacted]");
  });
});
