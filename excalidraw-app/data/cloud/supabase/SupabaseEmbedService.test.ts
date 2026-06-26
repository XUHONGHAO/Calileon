import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseEmbedService } from "./SupabaseEmbedService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const method of ["insert", "update", "select", "eq", "order", "limit"]) {
    builder[method] = record(method);
  }
  builder.single = (...args: unknown[]) => {
    calls.push({ method: "single", args });
    return Promise.resolve(result);
  };
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  (builder as { __calls: typeof calls }).__calls = calls;
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

const embedRow = {
  id: "embed-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  mode: "read",
  token: "token-1",
  allowed_origins: ["http://127.0.0.1:4313"],
  theme: "system",
  size: "responsive",
  revoked: false,
  created_at: "2026-06-24T10:00:00.000Z",
  updated_at: "2026-06-24T10:00:00.000Z",
};

const sceneRow = {
  id: "scene-1",
  owner_id: "owner-1",
  title: "Board",
  payload_kind: "plain",
  payload: { elements: [], appState: {} },
  version: 2,
  thumbnail_meta: null,
  created_at: "2026-06-24T10:00:00.000Z",
  updated_at: "2026-06-24T10:00:00.000Z",
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
  created_at: "2026-06-24T10:00:00.000Z",
  updated_at: "2026-06-24T10:00:00.000Z",
  deleted_at: null,
};

describe("SupabaseEmbedService", () => {
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

  it("creates owner-managed embed tokens", async () => {
    const builder = makeBuilder({ data: embedRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseEmbedService().create({
      sceneId: "scene-1",
      mode: "read",
      allowedOrigins: ["http://127.0.0.1:4313/host.html"],
    });

    expect(result.id).toBe("embed-1");
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const insert = calls.find((call) => call.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      scene_id: "scene-1",
      owner_id: "owner-1",
      mode: "read",
      allowed_origins: ["http://127.0.0.1:4313"],
    });
    expect((insert?.args[0] as { token: string }).token).toEqual(
      expect.any(String),
    );
  });

  it("rejects embeds without allowed origins before inserting", async () => {
    await expect(
      createSupabaseEmbedService().create({
        sceneId: "scene-1",
        mode: "read",
        allowedOrigins: ["*"],
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("lists and updates embeds by scene", async () => {
    const listBuilder = makeBuilder({ data: [embedRow], error: null });
    const updateBuilder = makeBuilder({
      data: { ...embedRow, mode: "write" },
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(listBuilder)
      .mockReturnValueOnce(updateBuilder);

    await createSupabaseEmbedService().listByScene("scene-1", { limit: 5 });
    await createSupabaseEmbedService().update("embed-1", { mode: "write" });

    expect(
      (listBuilder as { __calls: Array<{ method: string; args: unknown[] }> })
        .__calls,
    ).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["scene_id", "scene-1"] },
        { method: "limit", args: [5] },
      ]),
    );
    expect(
      (
        updateBuilder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls.find((call) => call.method === "update")?.args[0],
    ).toEqual({ mode: "write" });
  });

  it("revokes embed tokens", async () => {
    const builder = makeBuilder({ data: null, error: null });
    mockFrom.mockReturnValue(builder);

    await createSupabaseEmbedService().revoke("embed-1");

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((call) => call.method === "update")?.args[0]).toEqual({
      revoked: true,
    });
    expect(calls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["id", "embed-1"] }]),
    );
  });

  it("loads embedded scenes and signs asset URLs", async () => {
    mockRpc.mockResolvedValue({
      data: {
        scene: sceneRow,
        mode: "write",
        allowed_origins: ["http://127.0.0.1:4313"],
        theme: "light",
        size: "wide",
        assets: [assetRow],
      },
      error: null,
    });

    const result = await createSupabaseEmbedService().loadScene(
      "token-1",
      "http://127.0.0.1:4313/host.html",
    );

    expect(mockRpc).toHaveBeenCalledWith("load_embedded_scene", {
      p_token: "token-1",
      p_origin: "http://127.0.0.1:4313",
    });
    expect(result.scene.id).toBe("scene-1");
    expect(result.mode).toBe("write");
    expect(result.assets[0].url).toBe("https://signed.example/asset");
  });

  it("rejects empty embed RPC results", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await expect(
      createSupabaseEmbedService().resolve(
        "missing-token",
        "http://127.0.0.1:4313",
      ),
    ).rejects.toBeInstanceOf(BackendError);
  });

  it("saves writable embedded scenes through RPC", async () => {
    mockRpc.mockResolvedValue({
      data: { id: "scene-1", version: 3 },
      error: null,
    });

    const result = await createSupabaseEmbedService().saveScene(
      "token-1",
      "http://127.0.0.1:4313",
      {
        id: "scene-1",
        ownerId: "owner-1",
        title: "Board",
        payloadKind: "plain",
        payload: { elements: [] },
        version: 2,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      },
    );

    expect(result).toEqual({ id: "scene-1", version: 3 });
    expect(mockRpc).toHaveBeenCalledWith("save_embedded_scene", {
      p_token: "token-1",
      p_origin: "http://127.0.0.1:4313",
      p_payload: { elements: [] },
      p_title: "Board",
      p_version: 2,
      p_thumbnail_meta: null,
    });
  });

  it("uploads writable embedded assets by token and origin", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "resolve_cloud_embed") {
        return Promise.resolve({
          data: [
            {
              scene_id: "scene-1",
              owner_id: "owner-1",
              mode: "write",
              allowed_origins: ["http://127.0.0.1:4313"],
              theme: "system",
              size: "responsive",
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: assetRow, error: null });
    });

    const result = await createSupabaseEmbedService().uploadAsset({
      token: "token-1",
      origin: "http://127.0.0.1:4313",
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
    expect(mockRpc).toHaveBeenCalledWith("upsert_embedded_asset", {
      p_token: "token-1",
      p_origin: "http://127.0.0.1:4313",
      p_file_id: "file-1",
      p_type: "image",
      p_storage_path: "owner-1/scene-1/file-1",
      p_mime_type: "image/png",
      p_bytes: 4,
    });
  });
});
