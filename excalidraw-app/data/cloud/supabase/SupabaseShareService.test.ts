import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseShareService } from "./SupabaseShareService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ["insert", "update", "select", "eq", "order"]) {
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
const mockRpc = vi.fn();
const mockGetUser = vi.fn();
const mockStorageFrom = vi.fn();
const mockUpload = vi.fn();
const mockCreateSignedUrl = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const shareRow = {
  id: "share-1",
  scene_id: "scene-1",
  owner_id: "owner-1",
  mode: "read",
  token: "token-1",
  revoked: false,
  expires_at: null,
  created_at: "2026-06-20T10:00:00.000Z",
};

const sceneRow = {
  id: "scene-1",
  owner_id: "owner-1",
  title: "Board",
  payload_kind: "plain",
  payload: { elements: [], appState: {} },
  version: 2,
  thumbnail_meta: null,
  created_at: "2026-06-20T10:00:00.000Z",
  updated_at: "2026-06-20T10:00:00.000Z",
  deleted_at: null,
};

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

describe("SupabaseShareService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://signed.example/asset" },
      error: null,
    });
    mockUpload.mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({
      upload: mockUpload,
      createSignedUrl: mockCreateSignedUrl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates owner-managed share links", async () => {
    const builder = makeBuilder({ data: shareRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseShareService().create({
      sceneId: "scene-1",
      mode: "read",
    });

    expect(result).toMatchObject({ id: "share-1", token: "token-1" });
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const insert = calls.find((call) => call.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      scene_id: "scene-1",
      owner_id: "owner-1",
      mode: "read",
    });
    expect((insert?.args[0] as { token: string }).token).toEqual(
      expect.any(String),
    );
  });

  it("loads shared scenes and signs private asset URLs", async () => {
    mockRpc.mockResolvedValue({
      data: { scene: sceneRow, mode: "write", assets: [assetRow] },
      error: null,
    });

    const result = await createSupabaseShareService().loadScene("token-1");

    expect(mockRpc).toHaveBeenCalledWith("load_shared_scene", {
      p_token: "token-1",
    });
    expect(result.scene.id).toBe("scene-1");
    expect(result.mode).toBe("write");
    expect(result.assets[0].url).toBe("https://signed.example/asset");
  });

  it("saves writable shared scenes through RPC", async () => {
    mockRpc.mockResolvedValue({
      data: { id: "scene-1", version: 3 },
      error: null,
    });

    const result = await createSupabaseShareService().saveScene("token-1", {
      id: "scene-1",
      ownerId: "owner-1",
      title: "Board",
      payloadKind: "plain",
      payload: { elements: [] },
      version: 2,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });

    expect(result).toEqual({ id: "scene-1", version: 3 });
    expect(mockRpc).toHaveBeenCalledWith("save_shared_scene", {
      p_token: "token-1",
      p_payload: { elements: [] },
      p_title: "Board",
      p_version: 2,
      p_thumbnail_meta: null,
    });
  });

  it("maps shared version conflicts", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "cloud-share-version-conflict" },
    });

    const promise = createSupabaseShareService().saveScene("token-1", {
      id: "scene-1",
      ownerId: "owner-1",
      title: "Board",
      payloadKind: "plain",
      payload: {},
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });

    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await promise.catch((error) =>
      expect((error as BackendError).code).toBe("conflict"),
    );
  });

  it("uploads writable shared assets by token", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "resolve_cloud_share") {
        return Promise.resolve({
          data: [{ scene_id: "scene-1", owner_id: "owner-1", mode: "write" }],
          error: null,
        });
      }
      return Promise.resolve({ data: assetRow, error: null });
    });

    const result = await createSupabaseShareService().uploadAsset({
      token: "token-1",
      blob: new Blob(["data"], { type: "image/png" }),
      type: "image",
      sceneId: "scene-1",
      fileId: "file-1",
    });

    expect(result.fileId).toBe("file-1");
    expect(mockUpload).toHaveBeenCalledWith(
      "owner-1/scene-1/file-1",
      expect.any(Blob),
      { contentType: "image/png", upsert: true },
    );
    expect(mockRpc).toHaveBeenCalledWith("upsert_shared_asset", {
      p_token: "token-1",
      p_file_id: "file-1",
      p_type: "image",
      p_storage_path: "owner-1/scene-1/file-1",
      p_mime_type: "image/png",
      p_bytes: 4,
    });
  });
});
