import { STORAGE_KEYS } from "../app_constants";

import { AIImageGenerationError } from "./openAIImageAdapter";
import {
  __resetStaleVideoReferenceSweepForTests,
  canReleaseReferencesAfterSubmitError,
  submitRollDekVideoRun,
  sweepStaleVideoReferences,
} from "./rolldekVideoRun";

const createService = () => {
  let n = 0;
  return {
    upload: vi.fn(async () => {
      n += 1;
      return {
        assetId: `asset-${n}`,
        url: `https://supabase.example/sign/${n}?token=t`,
        expiresAt: 0,
      };
    }),
    remove: vi.fn(async (_assetIds: readonly string[]) => undefined),
    removeStale: vi.fn(async (_olderThanMs: number) => 0),
  };
};

const imageUpload = () => ({
  kind: "image" as const,
  blob: new Blob([new Uint8Array(2)], { type: "image/png" }),
  mimeType: "image/png",
});

const request = (
  overrides: Partial<
    Parameters<typeof submitRollDekVideoRun>[0]["request"]
  > = {},
) => ({
  protocol: "volc-tasks" as const,
  baseURL: "https://rolldek.com",
  apiKey: "sk-local-only",
  model: "doubao-seedance-2-5-260628",
  mode: "reference-to-video" as const,
  prompt: "#1 走进湖边",
  params: { size: "", n: 1, duration: 5, aspectRatio: "16:9" },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("submitRollDekVideoRun", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads references, submits their signed URLs and returns the ids", async () => {
    const service = createService();
    const fetchMock = vi.fn(async () => jsonResponse({ id: "task_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitting = vi.fn();

    await expect(
      submitRollDekVideoRun({
        request: request(),
        uploads: [imageUpload()],
        referenceService: service,
        referencesAllowed: true,
        onSubmitting,
      }),
    ).resolves.toEqual({
      taskId: "task_1",
      endpoint: "https://rolldek.com/api/v3/contents/generations/tasks",
      referenceAssetIds: ["asset-1"],
    });
    expect(onSubmitting).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(JSON.stringify(body.content)).toContain(
      "https://supabase.example/sign/1?token=t",
    );
  });

  it("skips uploads for text-to-video", async () => {
    const service = createService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "task_2" })),
    );

    await submitRollDekVideoRun({
      request: request({ mode: "text-to-video", prompt: "湖边" }),
      uploads: [],
      referenceService: undefined,
      referencesAllowed: false,
    });
    expect(service.upload).not.toHaveBeenCalled();
  });

  it("refuses references without a service or when uploads are not allowed", async () => {
    for (const [referenceService, referencesAllowed] of [
      [undefined, true],
      [createService(), false],
    ] as const) {
      await expect(
        submitRollDekVideoRun({
          request: request(),
          uploads: [imageUpload()],
          referenceService,
          referencesAllowed,
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
    }
  });

  it("validates before uploading anything", async () => {
    const service = createService();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitRollDekVideoRun({
        request: request({ params: { size: "", n: 1, duration: 99 } }),
        uploads: [imageUpload()],
        referenceService: service,
        referencesAllowed: true,
      }),
    ).rejects.toBeInstanceOf(AIImageGenerationError);
    expect(service.upload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes references after a rejected submit, keeps them after an unknown one", async () => {
    const rejectedService = createService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "invalid", message: "bad" } }, 400),
      ),
    );
    await expect(
      submitRollDekVideoRun({
        request: request(),
        uploads: [imageUpload()],
        referenceService: rejectedService,
        referencesAllowed: true,
      }),
    ).rejects.toMatchObject({ message: "bad" });
    expect(rejectedService.remove).toHaveBeenCalledWith(["asset-1"]);

    const unknownService = createService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ code: "fail_to_fetch_task", message: "retry" }, 503),
      ),
    );
    await expect(
      submitRollDekVideoRun({
        request: request(),
        uploads: [imageUpload()],
        referenceService: unknownService,
        referencesAllowed: true,
      }),
    ).rejects.toBeInstanceOf(AIImageGenerationError);
    expect(unknownService.remove).not.toHaveBeenCalled();
  });

  it("treats aborts as a possibly created task", () => {
    expect(
      canReleaseReferencesAfterSubmitError(
        new DOMException("aborted", "AbortError"),
      ),
    ).toBe(false);
    expect(
      canReleaseReferencesAfterSubmitError(
        new AIImageGenerationError("x", "request-failed", {
          submitOutcome: "rejected",
        }),
      ),
    ).toBe(true);
  });
});

describe("sweepStaleVideoReferences", () => {
  it("runs once per page load", () => {
    __resetStaleVideoReferenceSweepForTests();
    const service = createService();

    sweepStaleVideoReferences(undefined);
    sweepStaleVideoReferences(service);
    sweepStaleVideoReferences(service);

    expect(service.removeStale).toHaveBeenCalledTimes(1);
    expect(service.removeStale).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
  });
});
