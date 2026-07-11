import type { DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { AIImageGenerationError } from "./openAIImageAdapter";
import {
  buildVideoPollEndpoint,
  buildVideoRequestBody,
  buildVideoSubmitEndpoint,
  normalizeVideoStatus,
  pollVideoTask,
  submitVideoTask,
} from "./openAIVideoAdapter";

import type { AIVideoGenerationRequest } from "./types";

const baseRequest: AIVideoGenerationRequest = {
  config: {
    baseURL: "https://duoyuanx.com/v1",
    apiKey: "sk-local-only",
    defaultModel: "grok-video-3",
    models: [],
  },
  mode: "text-to-video",
  model: "grok-video-3",
  prompt: "a cat listening to music",
  params: {
    size: "720P",
    n: 1,
    duration: 6,
    aspectRatio: "9:16",
  },
};

describe("OpenAI-compatible video adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds submit and poll endpoints from the configured base URL", () => {
    expect(buildVideoSubmitEndpoint("https://duoyuanx.com/v1/")).toBe(
      "https://duoyuanx.com/v1/videos",
    );
    expect(buildVideoSubmitEndpoint("https://duoyuanx.com/v1/videos")).toBe(
      "https://duoyuanx.com/v1/videos",
    );
    expect(
      buildVideoPollEndpoint("https://duoyuanx.com/v1", "video_abc123"),
    ).toBe("https://duoyuanx.com/v1/videos/video_abc123");
    expect(
      buildVideoPollEndpoint(
        "https://duoyuanx.com/v1/videos/old_task",
        "video_abc123",
      ),
    ).toBe("https://duoyuanx.com/v1/videos/video_abc123");
  });

  it("builds a text-to-video body with seconds and aspect ratio", () => {
    const body = buildVideoRequestBody(baseRequest);

    expect(body).toEqual({
      model: "grok-video-3",
      prompt: "a cat listening to music",
      seconds: "6",
      size: "720P",
      aspect_ratio: "9:16",
    });
    expect(JSON.stringify(body)).not.toContain("sk-local-only");
  });

  it("omits auto aspect ratio / resolution and attaches image for image-to-video", () => {
    const image = new File(["frame"], "frame.png", { type: "image/png" });
    const body = buildVideoRequestBody({
      ...baseRequest,
      mode: "image-to-video",
      params: {
        size: "",
        n: 1,
        aspectRatio: "auto",
        resolution: "auto",
      },
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: image,
        },
      ],
    });

    expect(body).toEqual({
      model: "grok-video-3",
      prompt: "a cat listening to music",
      image: "data:image/png;base64,AAA",
    });
  });

  it("throws when image-to-video has no reference image", () => {
    expect(() =>
      buildVideoRequestBody({ ...baseRequest, mode: "image-to-video" }),
    ).toThrowError(AIImageGenerationError);
  });

  it("normalizes the many upstream status spellings", () => {
    expect(normalizeVideoStatus("queued")).toBe("queued");
    expect(normalizeVideoStatus("pending")).toBe("queued");
    expect(normalizeVideoStatus("submitted")).toBe("queued");
    expect(normalizeVideoStatus("processing")).toBe("processing");
    expect(normalizeVideoStatus("in_progress")).toBe("processing");
    expect(normalizeVideoStatus("running")).toBe("processing");
    expect(normalizeVideoStatus("completed")).toBe("completed");
    expect(normalizeVideoStatus("succeeded")).toBe("completed");
    expect(normalizeVideoStatus("SUCCESS")).toBe("completed");
    expect(normalizeVideoStatus("failed")).toBe("failed");
    expect(normalizeVideoStatus("failure")).toBe("failed");
    expect(normalizeVideoStatus("unknown-thing")).toBe("processing");
  });

  it("submits a task and reads the task id from `id`", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ id: "video_abc123", status: "queued", progress: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await submitVideoTask(baseRequest);

    expect(result).toEqual({
      taskId: "video_abc123",
      endpoint: "https://duoyuanx.com/v1/videos",
      model: "grok-video-3",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://duoyuanx.com/v1/videos",
      expect.objectContaining({ method: "POST" }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer sk-local-only",
    );
  });

  it("falls back to `task_id` when `id` is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ task_id: "task-xyz", status: "processing" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await submitVideoTask(baseRequest);

    expect(result.taskId).toBe("task-xyz");
  });

  it("throws when submission returns no task id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(submitVideoTask(baseRequest)).rejects.toEqual(
      expect.objectContaining({ code: "invalid-response" }),
    );
  });

  it("maps auth failures on submit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(submitVideoTask(baseRequest)).rejects.toEqual(
      expect.objectContaining({ code: "auth" }),
    );
  });

  it("reports a processing poll with progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ status: "in_progress", progress: "50%" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await pollVideoTask({
      baseURL: "https://duoyuanx.com/v1",
      apiKey: "sk-local-only",
      taskId: "video_abc123",
    });

    expect(result).toEqual({ status: "processing", progress: 50 });
  });

  it("returns the result URL on completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            status: "completed",
            progress: 100,
            video_url: "https://cdn.example.com/out.mp4",
            thumbnail_url: "https://cdn.example.com/thumb.png",
            seconds: 6,
            revised_prompt: "a fluffy cat listening to music",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await pollVideoTask({
      baseURL: "https://duoyuanx.com/v1",
      apiKey: "sk-local-only",
      taskId: "video_abc123",
    });

    expect(result).toEqual({
      status: "completed",
      progress: 100,
      videoURL: "https://cdn.example.com/out.mp4",
      thumbnailURL: "https://cdn.example.com/thumb.png",
      durationSeconds: 6,
      revisedPrompt: "a fluffy cat listening to music",
    });
  });

  it("falls back through output.url and data[].url for the result address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            status: "success",
            data: [{ url: "https://cdn.example.com/from-data.mp4" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await pollVideoTask({
      baseURL: "https://duoyuanx.com/v1",
      apiKey: "sk-local-only",
      taskId: "video_abc123",
    });

    expect(result.videoURL).toBe("https://cdn.example.com/from-data.mp4");
  });

  it("throws when a completed task has no video URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ status: "completed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(
      pollVideoTask({
        baseURL: "https://duoyuanx.com/v1",
        apiKey: "sk-local-only",
        taskId: "video_abc123",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid-response" }));
  });

  it("surfaces the failure reason on a failed task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            status: "failed",
            error: { message: "Content policy violation" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await pollVideoTask({
      baseURL: "https://duoyuanx.com/v1",
      apiKey: "sk-local-only",
      taskId: "video_abc123",
    });

    expect(result).toEqual({
      status: "failed",
      progress: undefined,
      error: "Content policy violation",
    });
  });

  it("wraps network errors as cors-or-network on poll", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      pollVideoTask({
        baseURL: "https://duoyuanx.com/v1",
        apiKey: "sk-local-only",
        taskId: "video_abc123",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "cors-or-network" }));
  });
});
