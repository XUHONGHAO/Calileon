import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseVideoAssetService } from "./SupabaseVideoAssetService";

const mockInvoke = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    functions: { invoke: mockInvoke },
  }),
}));

describe("SupabaseVideoAssetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes the ingest function with an idempotent scene-bound request", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        assetId: "asset-1",
        mimeType: "video/mp4",
        bytes: 1024,
        durationSeconds: 4,
      },
      error: null,
    });

    const result = await createSupabaseVideoAssetService().ingest({
      sceneId: "scene-1",
      sourceUrl: "https://provider.example/video?token=secret",
      expectedMimeType: "video/mp4",
      idempotencyKey: "task-1",
    });

    expect(result.assetId).toBe("asset-1");
    expect(mockInvoke).toHaveBeenCalledWith("ai-video-ingest", {
      body: {
        sceneId: "scene-1",
        sourceUrl: "https://provider.example/video?token=secret",
        expectedMimeType: "video/mp4",
        idempotencyKey: "task-1",
      },
    });
  });

  it("resolves owner/share/embed access without persisting the returned URL", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        url: "https://signed.example/video?token=runtime-only",
        expiresAt: Date.now() + 300_000,
        mimeType: "video/mp4",
      },
      error: null,
    });

    const service = createSupabaseVideoAssetService();
    const result = await service.resolve({
      assetId: "asset-1",
      access: { kind: "share", token: "share-token" },
    });

    expect(result.url).toContain("runtime-only");
    expect(mockInvoke).toHaveBeenCalledWith("video-asset-resolve", {
      body: {
        assetId: "asset-1",
        access: { kind: "share", token: "share-token" },
      },
    });
  });

  it("rejects malformed function payloads with a sanitized BackendError", async () => {
    mockInvoke.mockResolvedValue({
      data: { assetId: "asset-1", sourceUrl: "https://secret.example" },
      error: null,
    });

    await expect(
      createSupabaseVideoAssetService().ingest({
        sceneId: "scene-1",
        sourceUrl: "https://provider.example/video?token=secret",
        idempotencyKey: "task-1",
      }),
    ).rejects.toMatchObject({
      name: "BackendError",
      code: "network",
    });
  });

  it("maps authorization failures without exposing function payloads", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: { context: { status: 403 }, message: "sourceUrl=secret" },
    });

    const promise = createSupabaseVideoAssetService().resolve({
      assetId: "asset-1",
      access: { kind: "owner" },
    });

    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await promise.catch((error) => {
      expect((error as BackendError).code).toBe("forbidden");
      expect((error as Error).message).not.toContain("sourceUrl");
    });
  });

  it("honors an already-aborted request without invoking the function", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createSupabaseVideoAssetService().ingest({
        sceneId: "scene-1",
        sourceUrl: "https://provider.example/video",
        idempotencyKey: "task-1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
