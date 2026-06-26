import {
  appendAIGenerationLog,
  clearAIGenerationLogs,
  createAIGenerationLogEntry,
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
});
