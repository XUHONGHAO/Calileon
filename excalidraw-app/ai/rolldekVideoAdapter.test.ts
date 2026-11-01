import { STORAGE_KEYS } from "../app_constants";

import { AIImageGenerationError } from "./openAIImageAdapter";
import {
  buildRollDekContentURL,
  buildRollDekPollURL,
  buildRollDekSdRequestBody,
  buildRollDekSubmitURL,
  buildRollDekVolcRequestBody,
  normalizeRollDekBaseURL,
  normalizeRollDekStatus,
  pollRollDekVideoTask,
  rewriteRollDekPromptReferences,
  submitRollDekVideoTask,
} from "./rolldekVideoAdapter";

import type { RollDekVideoRequest } from "./rolldekVideoAdapter";
import type { AIVideoReference } from "./types";

const image = (name: string): AIVideoReference => ({
  kind: "image",
  url: `https://supabase.calileon.com/storage/v1/object/sign/excalidraw-assets/${name}.png?token=t`,
});
const video: AIVideoReference = {
  kind: "video",
  url: "https://supabase.calileon.com/storage/v1/object/sign/x/motion.mp4?token=t",
};
const audio: AIVideoReference = {
  kind: "audio",
  url: "https://supabase.calileon.com/storage/v1/object/sign/x/beat.mp3?token=t",
};

const sdRequest = (
  overrides: Partial<RollDekVideoRequest> = {},
): RollDekVideoRequest => ({
  protocol: "rolldek-sd",
  baseURL: "https://rolldek.com",
  apiKey: "sk-local-only",
  model: "sd-2.5-ch5",
  mode: "text-to-video",
  prompt: "清晨的高山湖泊",
  params: { size: "", n: 1, duration: 6, aspectRatio: "16:9" },
  ...overrides,
});

const volcRequest = (
  overrides: Partial<RollDekVideoRequest> = {},
): RollDekVideoRequest => ({
  ...sdRequest(),
  protocol: "volc-tasks",
  model: "doubao-seedance-2-5-260628",
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const expectError = async (
  promise: Promise<unknown>,
  match: Record<string, unknown>,
) => {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(AIImageGenerationError);
  expect(error).toMatchObject(match);
  return error as AIImageGenerationError;
};

describe("RollDek video adapter", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds paths from a bare host, tolerating a pasted API prefix", () => {
    expect(normalizeRollDekBaseURL(" https://rolldek.com/v1/ ")).toBe(
      "https://rolldek.com",
    );
    expect(normalizeRollDekBaseURL("https://api-cn.rolldek.com/api/v3")).toBe(
      "https://api-cn.rolldek.com",
    );
    expect(buildRollDekSubmitURL("rolldek-sd", "https://rolldek.com")).toBe(
      "https://rolldek.com/v1/videos",
    );
    expect(
      buildRollDekPollURL("volc-tasks", "https://rolldek.com/v1", "task_a/b"),
    ).toBe("https://rolldek.com/api/v3/contents/generations/tasks/task_a%2Fb");
    expect(buildRollDekContentURL("https://api-cn.rolldek.com", "task_1")).toBe(
      "https://api-cn.rolldek.com/v1/videos/task_1/content",
    );
  });

  it("maps both protocols' statuses, including expired", () => {
    expect(normalizeRollDekStatus("in_progress")).toBe("processing");
    expect(normalizeRollDekStatus("running")).toBe("processing");
    expect(normalizeRollDekStatus("succeeded")).toBe("completed");
    expect(normalizeRollDekStatus("expired")).toBe("failed");
    expect(normalizeRollDekStatus("cancelled")).toBe("failed");
    expect(normalizeRollDekStatus("queued")).toBe("queued");
  });

  it("rewrites #n references per protocol, numbering each kind separately", () => {
    const references = [image("a"), video, image("b"), audio];
    const prompt = "#1 走进 #3，动作参考 #2，节奏 图 4，#9 不存在";

    expect(
      rewriteRollDekPromptReferences(
        prompt,
        "rolldek-sd",
        references,
        "reference-to-video",
      ),
    ).toBe("@Image1 走进 @Image2，动作参考 @Video1，节奏 @Audio1，#9 不存在");
    expect(
      rewriteRollDekPromptReferences(
        prompt,
        "volc-tasks",
        references,
        "reference-to-video",
      ),
    ).toBe("图片1 走进 图片2，动作参考 视频1，节奏 音频1，#9 不存在");
    expect(
      rewriteRollDekPromptReferences(
        "从 #1 过渡到 #2",
        "volc-tasks",
        [image("a"), image("b")],
        "first-last-frame",
      ),
    ).toBe("从 首帧 过渡到 尾帧");
  });

  it("builds an sd body with an integer duration and *_refs arrays", () => {
    expect(
      buildRollDekSdRequestBody(
        sdRequest({
          mode: "reference-to-video",
          prompt: "保持 #1 外观，参考 #2 的动作",
          references: [image("a"), video],
          params: { size: "", n: 1, duration: 6.4, resolution: "720P" },
        }),
      ),
    ).toEqual({
      model: "sd-2.5-ch5",
      prompt: "保持 @Image1 外观，参考 @Video1 的动作",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
      image_refs: [image("a").url],
      video_refs: [video.url],
    });
  });

  it("always sends a duration, since ch5 defaults to 30 s", () => {
    const body = buildRollDekSdRequestBody(
      sdRequest({ params: { size: "", n: 1 } }),
    );

    expect(body.duration).toBe(5);
    expect("image_refs" in body).toBe(false);
  });

  it("uses 933's preferred field names", () => {
    const references = sdRequest({
      model: "SD2.0满血稳定933",
      mode: "reference-to-video",
      references: [image("a"), audio],
      params: { size: "", n: 1, duration: 4, seed: 0 },
    });

    expect(buildRollDekSdRequestBody(references)).toMatchObject({
      seconds: 4,
      images: [image("a").url],
      reference_audios: [audio.url],
      seed: 0,
    });

    const frames = buildRollDekSdRequestBody(
      sdRequest({
        model: "SD2.0满血稳定933",
        mode: "first-last-frame",
        references: [image("first"), image("last")],
        params: { size: "", n: 1, duration: 6 },
      }),
    );

    expect(frames).toMatchObject({
      first_frame_image: image("first").url,
      last_frame_image: image("last").url,
    });
    expect("images" in frames).toBe(false);
  });

  it("uses first_image/last_image on the 2.5 channels", () => {
    expect(
      buildRollDekSdRequestBody(
        sdRequest({
          mode: "first-last-frame",
          references: [image("first"), image("last")],
        }),
      ),
    ).toMatchObject({
      first_image: image("first").url,
      last_image: image("last").url,
    });
  });

  it("builds a Volcengine content[] body with roles in tray order", () => {
    expect(
      buildRollDekVolcRequestBody(
        volcRequest({
          mode: "reference-to-video",
          prompt: "#1 跟着 #2 的节奏",
          references: [image("a"), audio],
          params: {
            size: "",
            n: 1,
            duration: 6,
            aspectRatio: "9:16",
            resolution: "1080P",
            seed: 42,
          },
        }),
      ),
    ).toEqual({
      model: "doubao-seedance-2-5-260628",
      content: [
        { type: "text", text: "图片1 跟着 音频1 的节奏" },
        {
          type: "image_url",
          image_url: { url: image("a").url },
          role: "reference_image",
        },
        {
          type: "audio_url",
          audio_url: { url: audio.url },
          role: "reference_audio",
        },
      ],
      resolution: "1080p",
      duration: 6,
      ratio: "9:16",
      seed: 42,
    });

    const frames = buildRollDekVolcRequestBody(
      volcRequest({
        mode: "first-last-frame",
        references: [image("first"), image("last")],
      }),
    );

    expect(
      (frames.content as Array<{ role?: string }>).map((item) => item.role),
    ).toEqual([undefined, "first_frame", "last_frame"]);
  });

  it("rejects data and blob URLs before sending anything", () => {
    for (const url of ["data:image/png;base64,AAAA", "blob:https://x/1"]) {
      expect(() =>
        buildRollDekSdRequestBody(
          sdRequest({
            mode: "reference-to-video",
            references: [{ kind: "image", url }],
          }),
        ),
      ).toThrow(/public HTTPS URLs/);
    }
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({
          mode: "reference-to-video",
          references: [{ kind: "image", url: "http://example.com/a.png" }],
        }),
      ),
    ).toThrow(/public HTTPS URLs/);
  });

  it("enforces catalog limits", () => {
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({ params: { size: "", n: 1, duration: 4 } }),
      ),
    ).toThrow(/5–30 s/);
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({
          model: "sd-2.5-ch3",
          mode: "reference-to-video",
          references: [video],
        }),
      ),
    ).toThrow(/at most 9 images, 0 videos/);
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({
          model: "sd-2.5-ch3",
          params: { size: "", n: 1, duration: 5, aspectRatio: "3:2" },
        }),
      ),
    ).toThrow(/aspect ratio 3:2/);
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({
          model: "sd-2.0-ch1",
          mode: "first-last-frame",
          references: [image("a"), image("b")],
        }),
      ),
    ).toThrow(/does not support first\/last frames/);
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({ params: { size: "", n: 1, resolution: "1080p" } }),
      ),
    ).toThrow(/resolution 1080p/);
    expect(() =>
      buildRollDekVolcRequestBody(volcRequest({ model: "sd-2.5-ch5" })),
    ).toThrow(/rolldek-sd protocol/);
    expect(() =>
      buildRollDekSdRequestBody(
        sdRequest({ mode: "first-last-frame", references: [image("a")] }),
      ),
    ).toThrow(/exactly two images/);
  });

  it("drops seed for channels that do not document it", () => {
    const body = buildRollDekSdRequestBody(
      sdRequest({
        model: "sd-2.5-ch1",
        params: { size: "", n: 1, duration: 5, seed: 7 },
      }),
    );

    expect("seed" in body).toBe(false);
  });

  it("only checks URLs and modes for models outside the catalog", () => {
    expect(
      buildRollDekSdRequestBody(
        sdRequest({
          model: "sd-2.5-ch6",
          params: { size: "", n: 1, duration: 60, aspectRatio: "5:4" },
        }),
      ),
    ).toMatchObject({ model: "sd-2.5-ch6", duration: 60, aspect_ratio: "5:4" });
  });
});

describe("RollDek video adapter network", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits once with Bearer auth and reads `id`", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "task_lzp", object: "video", status: "queued" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitRollDekVideoTask(volcRequest())).resolves.toEqual({
      taskId: "task_lzp",
      endpoint: "https://rolldek.com/api/v3/contents/generations/tasks",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer sk-local-only",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks 4xx as rejected and 5xx / missing ids as unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "invalid_request",
            message: "prompt is required",
            data: null,
          },
          400,
        ),
      ),
    );
    const rejected = await expectError(submitRollDekVideoTask(sdRequest()), {
      message: "prompt is required",
    });
    expect(rejected.details).toMatchObject({ submitOutcome: "rejected" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "fail_to_fetch_task",
            message: "Please retry later.",
            data: null,
          },
          503,
        ),
      ),
    );
    const unknown = await expectError(submitRollDekVideoTask(sdRequest()), {});
    expect(unknown.details).toMatchObject({ submitOutcome: "unknown" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "queued" })),
    );
    const noId = await expectError(submitRollDekVideoTask(sdRequest()), {
      code: "invalid-response",
    });
    expect(noId.details).toMatchObject({ submitOutcome: "unknown" });
  });

  it("marks network failures as unknown and rethrows aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = await expectError(submitRollDekVideoTask(sdRequest()), {
      code: "cors-or-network",
    });
    expect(error.details).toMatchObject({ submitOutcome: "unknown" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    await expect(submitRollDekVideoTask(sdRequest())).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("refuses the managed gateway instead of falling back to direct", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectError(
      submitRollDekVideoTask(
        sdRequest({
          config: {
            version: 2,
            mode: "managed-gateway",
            endpoint: "",
            accessToken: "",
            gatewayEndpoint: "",
            managedRoutes: {},
          },
        }),
      ),
      { code: "proxy-config" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls a succeeded Volcengine task into the configured content URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "task_lzp",
          status: "succeeded",
          // A response URL on another host must never receive the key.
          content: { video_url: "https://evil.example/v1/videos/x/content" },
          usage: { completion_tokens: 83505, total_tokens: 83505 },
          duration: 4,
        }),
      ),
    );

    await expect(
      pollRollDekVideoTask({
        protocol: "volc-tasks",
        baseURL: "https://api-cn.rolldek.com",
        apiKey: "sk-local-only",
        taskId: "task_lzp",
      }),
    ).resolves.toEqual({
      status: "completed",
      videoURL: "https://api-cn.rolldek.com/v1/videos/task_lzp/content",
      durationSeconds: 4,
      totalTokens: 83505,
    });
  });

  it("reports sd progress and task failures with the provider message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ id: "t", status: "in_progress", progress: 30 }),
      ),
    );
    await expect(
      pollRollDekVideoTask({
        protocol: "rolldek-sd",
        baseURL: "https://rolldek.com",
        apiKey: "k",
        taskId: "t",
      }),
    ).resolves.toEqual({ status: "processing", progress: 30 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "t",
          status: "failed",
          progress: 100,
          error: {
            code: "task_failed",
            message: "该模型暂时没有可用生成资源，请稍后重试或更换模型。",
          },
        }),
      ),
    );
    await expect(
      pollRollDekVideoTask({
        protocol: "rolldek-sd",
        baseURL: "https://rolldek.com",
        apiKey: "k",
        taskId: "t",
      }),
    ).resolves.toEqual({
      status: "failed",
      progress: 100,
      error: "该模型暂时没有可用生成资源，请稍后重试或更换模型。",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "t", status: "expired" })),
    );
    await expect(
      pollRollDekVideoTask({
        protocol: "volc-tasks",
        baseURL: "https://rolldek.com",
        apiKey: "k",
        taskId: "t",
      }),
    ).resolves.toEqual({ status: "failed", error: "Video task expired." });
  });

  it("flags a missing task in both error shapes", async () => {
    for (const [protocol, status, body] of [
      [
        "rolldek-sd",
        400,
        { code: "task_not_exist", message: "task_not_exist", data: null },
      ],
      [
        "volc-tasks",
        404,
        { error: { code: "task_not_found", message: "task not found" } },
      ],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(body, status)),
      );
      const error = await expectError(
        pollRollDekVideoTask({
          protocol,
          baseURL: "https://rolldek.com",
          apiKey: "k",
          taskId: "t",
        }),
        {},
      );
      expect(error.details).toMatchObject({ taskNotFound: true });
    }
  });
});
