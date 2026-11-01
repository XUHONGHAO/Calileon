import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  VIDEO_REFERENCE_URL_TTL_SECONDS,
  createSupabaseVideoReferenceService,
} from "./SupabaseVideoReferenceService";

type Call = { method: string; args: unknown[] };

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = { __calls: calls };
  for (const method of [
    "insert",
    "delete",
    "select",
    "eq",
    "in",
    "lt",
    "limit",
  ]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.single = () => Promise.resolve(result);
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder as Record<string, unknown> & { __calls: Call[] };
};

const mockFrom = vi.fn();
const mockGetUser = vi.fn();
const mockUpload = vi.fn();
const mockRemove = vi.fn();
const mockCreateSignedUrl = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    storage: {
      from: () => ({
        upload: mockUpload,
        remove: mockRemove,
        createSignedUrl: mockCreateSignedUrl,
      }),
    },
    auth: { getUser: mockGetUser },
  }),
}));

const blob = () => new Blob([new Uint8Array(4)], { type: "image/png" });

describe("SupabaseVideoReferenceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
    mockUpload.mockResolvedValue({ error: null });
    mockRemove.mockResolvedValue({ error: null });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://supabase.example/sign/x?token=t" },
      error: null,
    });
  });

  it("uploads outside any scene folder and signs for 2 hours", async () => {
    const insert = makeBuilder({ data: { id: "asset-1" }, error: null });
    mockFrom.mockReturnValue(insert);

    const result = await createSupabaseVideoReferenceService().upload({
      blob: blob(),
      mimeType: "image/png",
    });

    const storagePath = mockUpload.mock.calls[0][0] as string;
    expect(storagePath).toMatch(/^owner-1\/ai-video-reference\/[^/]+$/);
    expect(mockUpload.mock.calls[0][2]).toEqual({
      contentType: "image/png",
      upsert: false,
    });
    expect(insert.__calls[0]).toMatchObject({
      method: "insert",
      args: [
        expect.objectContaining({
          owner_id: "owner-1",
          scene_id: null,
          type: "ai-video-reference",
          storage_path: storagePath,
          bytes: 4,
        }),
      ],
    });
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(storagePath, 7200);
    expect(VIDEO_REFERENCE_URL_TTL_SECONDS).toBe(7200);
    expect(result).toMatchObject({
      assetId: "asset-1",
      url: "https://supabase.example/sign/x?token=t",
    });
  });

  it("requires a signed-in user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(
      createSupabaseVideoReferenceService().upload({
        blob: blob(),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ name: "BackendError", code: "unauthorized" });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("removes the uploaded object when the row insert fails", async () => {
    mockFrom.mockReturnValue(
      makeBuilder({ data: null, error: { message: "denied", code: "42501" } }),
    );

    await expect(
      createSupabaseVideoReferenceService().upload({
        blob: blob(),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ name: "BackendError" });
    expect(mockRemove).toHaveBeenCalledWith([mockUpload.mock.calls[0][0]]);
  });

  it("deletes objects and rows, only of the reference type", async () => {
    const select = makeBuilder({
      data: [{ id: "asset-1", storage_path: "owner-1/ai-video-reference/f" }],
      error: null,
    });
    const del = makeBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(select).mockReturnValueOnce(del);

    await createSupabaseVideoReferenceService().remove(["asset-1", "gone"]);

    expect(select.__calls).toContainEqual({
      method: "eq",
      args: ["type", "ai-video-reference"],
    });
    expect(mockRemove).toHaveBeenCalledWith(["owner-1/ai-video-reference/f"]);
    expect(del.__calls).toEqual([
      { method: "delete", args: [] },
      { method: "in", args: ["id", ["asset-1"]] },
      { method: "eq", args: ["type", "ai-video-reference"] },
    ]);
  });

  it("cleans up stale references by age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
    const select = makeBuilder({
      data: [{ id: "old", storage_path: "owner-1/ai-video-reference/old" }],
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(select)
      .mockReturnValueOnce(makeBuilder({ data: null, error: null }));

    await expect(
      createSupabaseVideoReferenceService().removeStale(24 * 60 * 60 * 1000),
    ).resolves.toBe(1);
    expect(select.__calls).toContainEqual({
      method: "lt",
      args: ["created_at", "2026-10-29T12:00:00.000Z"],
    });
    vi.useRealTimers();
  });

  it("does nothing for an empty id list", async () => {
    await createSupabaseVideoReferenceService().remove([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
