import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseAssetStorage } from "./SupabaseAssetStorage";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of [
    "insert",
    "update",
    "upsert",
    "select",
    "eq",
    "is",
    "order",
  ]) {
    builder[m] = record(m);
  }
  builder.single = (...args: unknown[]) => {
    calls.push({ method: "single", args });
    return Promise.resolve(result);
  };
  builder.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  (builder as { __calls: unknown }).__calls = calls;
  return builder;
};

const mockFrom = vi.fn();
const mockStorageFrom = vi.fn();
const mockGetUser = vi.fn();
const mockUpload = vi.fn();
const mockCreateSignedUrl = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    storage: { from: mockStorageFrom },
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const signedIn = () =>
  mockGetUser.mockResolvedValue({
    data: { user: { id: "owner-1" } },
    error: null,
  });

const assetRow = {
  id: "asset-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  file_id: "file-1",
  type: "image",
  storage_path: "owner-1/scene-1/file-1",
  mime_type: "image/png",
  bytes: 4,
  created_at: "2026-06-20T10:00:00.000Z",
  updated_at: "2026-06-20T10:00:00.000Z",
  deleted_at: null,
};

describe("SupabaseAssetStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn();
    mockUpload.mockResolvedValue({ error: null });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://signed.example/asset" },
      error: null,
    });
    mockStorageFrom.mockReturnValue({
      upload: mockUpload,
      createSignedUrl: mockCreateSignedUrl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads to the private bucket and upserts metadata by owner/scene/file", async () => {
    const builder = makeBuilder({ data: assetRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseAssetStorage().upload({
      blob: new Blob(["data"], { type: "image/png" }),
      type: "image",
      sceneId: "scene-1",
      fileId: "file-1",
    });

    expect(result).toMatchObject({
      id: "asset-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      fileId: "file-1",
      url: "https://signed.example/asset",
      mimeType: "image/png",
      bytes: 4,
    });
    expect(mockStorageFrom).toHaveBeenCalledWith("excalidraw-assets");
    expect(mockUpload).toHaveBeenCalledWith(
      "owner-1/scene-1/file-1",
      expect.any(Blob),
      { contentType: "image/png", upsert: true },
    );

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const upsert = calls.find((c) => c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({
      owner_id: "owner-1",
      scene_id: "scene-1",
      file_id: "file-1",
      storage_path: "owner-1/scene-1/file-1",
    });
    expect(upsert?.args[1]).toEqual({
      onConflict: "owner_id,scene_id,file_id",
    });
  });

  it("preserves recording/export asset metadata for cast artifacts", async () => {
    const recordingRow = {
      ...assetRow,
      id: "recording-1",
      type: "recording",
      mime_type: "application/json",
      storage_path: "owner-1/scene-1/cast-script.json",
      file_id: "cast-script.json",
      bytes: 13,
    };
    const builder = makeBuilder({ data: recordingRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseAssetStorage().upload({
      blob: new Blob(['{"events":[]}'], { type: "application/json" }),
      type: "recording",
      sceneId: "scene-1",
      fileId: "cast-script.json",
    });

    expect(result).toMatchObject({
      id: "recording-1",
      type: "recording",
      mimeType: "application/json",
    });
    expect(mockUpload).toHaveBeenCalledWith(
      "owner-1/scene-1/cast-script.json",
      expect.any(Blob),
      { contentType: "application/json", upsert: true },
    );

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((c) => c.method === "upsert")?.args[0]).toMatchObject({
      type: "recording",
      mime_type: "application/json",
    });
  });

  it("lists scene assets and signs each private object URL", async () => {
    const builder = makeBuilder({ data: [assetRow], error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseAssetStorage().listByScene("scene-1");

    expect(result).toHaveLength(1);
    expect(result[0].fileId).toBe("file-1");
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(
      "owner-1/scene-1/file-1",
      3600,
    );

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(
      calls.some((c) => c.method === "eq" && c.args[0] === "scene_id"),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === "is" && c.args[0] === "deleted_at"),
    ).toBe(true);
  });

  it("soft-deletes asset metadata", async () => {
    const builder = makeBuilder({ error: null });
    mockFrom.mockReturnValue(builder);

    await createSupabaseAssetStorage().remove("asset-1");

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toHaveProperty("deleted_at");
  });

  it("maps storage permission failures to BackendError", async () => {
    mockUpload.mockResolvedValue({ error: { statusCode: "403" } });
    const builder = makeBuilder({ data: assetRow, error: null });
    mockFrom.mockReturnValue(builder);

    const promise = createSupabaseAssetStorage().upload({
      blob: new Blob(["data"], { type: "image/png" }),
      type: "image",
      sceneId: "scene-1",
      fileId: "file-1",
    });

    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await promise.catch((error) =>
      expect((error as BackendError).code).toBe("forbidden"),
    );
  });
});
