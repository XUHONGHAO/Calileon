import { describe, expect, it, vi } from "vitest";

import {
  VideoReferenceTypeError,
  isAllowedVideoReferenceType,
  releaseVideoReferences,
  uploadVideoReferences,
} from "./videoReferenceUploads";

import type { VideoReferenceService } from "../data/cloud/types";

const createService = (
  upload: VideoReferenceService["upload"] = vi.fn(async () => ({
    assetId: `asset-${Math.random()}`,
    url: "https://supabase.example/sign/x?token=t",
    expiresAt: Date.now() + 7_200_000,
  })),
): VideoReferenceService & {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} => ({
  upload: upload as ReturnType<typeof vi.fn>,
  remove: vi.fn(async () => undefined),
  removeStale: vi.fn(async () => 0),
});

const input = (
  kind: "image" | "video" | "audio",
  mimeType: string,
  durationSeconds?: number,
) => ({
  kind,
  blob: new Blob([new Uint8Array(2)], { type: mimeType }),
  mimeType,
  durationSeconds,
});

describe("video reference uploads", () => {
  it("uploads in tray order and returns signed references", async () => {
    let n = 0;
    const service = createService(
      vi.fn(async () => {
        n += 1;
        return {
          assetId: `asset-${n}`,
          url: `https://supabase.example/sign/${n}?token=t`,
          expiresAt: 0,
        };
      }),
    );

    const result = await uploadVideoReferences(service, [
      input("image", "image/png"),
      input("video", "video/mp4; codecs=avc1", 4),
      input("audio", "audio/mpeg"),
    ]);

    expect(result).toEqual({
      assetIds: ["asset-1", "asset-2", "asset-3"],
      references: [
        { kind: "image", url: "https://supabase.example/sign/1?token=t" },
        {
          kind: "video",
          url: "https://supabase.example/sign/2?token=t",
          durationSeconds: 4,
        },
        { kind: "audio", url: "https://supabase.example/sign/3?token=t" },
      ],
    });
    expect(service.upload.mock.calls[1][0]).toMatchObject({
      mimeType: "video/mp4",
    });
  });

  it("rejects unsupported types before uploading anything", async () => {
    const service = createService();

    await expect(
      uploadVideoReferences(service, [
        input("image", "image/png"),
        input("audio", "audio/wav"),
      ]),
    ).rejects.toBeInstanceOf(VideoReferenceTypeError);
    expect(service.upload).not.toHaveBeenCalled();
    expect(isAllowedVideoReferenceType("image", "image/svg+xml")).toBe(false);
    expect(isAllowedVideoReferenceType("video", "video/webm")).toBe(true);
  });

  it("deletes earlier uploads when a later one fails", async () => {
    const service = createService(
      vi
        .fn()
        .mockResolvedValueOnce({
          assetId: "asset-1",
          url: "https://a",
          expiresAt: 0,
        })
        .mockRejectedValueOnce(new Error("quota")),
    );

    await expect(
      uploadVideoReferences(service, [
        input("image", "image/png"),
        input("image", "image/jpeg"),
      ]),
    ).rejects.toThrow("quota");
    expect(service.remove).toHaveBeenCalledWith(["asset-1"]);
  });

  it("releases best effort and skips empty lists", async () => {
    const service = createService();
    service.remove.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      releaseVideoReferences(service, ["asset-1"]),
    ).resolves.toBeUndefined();
    await releaseVideoReferences(service, []);
    await releaseVideoReferences(undefined, ["asset-2"]);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
