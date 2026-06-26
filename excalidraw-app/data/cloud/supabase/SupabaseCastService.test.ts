import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseCastService } from "./SupabaseCastService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const method of [
    "insert",
    "update",
    "select",
    "eq",
    "is",
    "order",
    "limit",
  ]) {
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
const mockGetUser = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const sessionRow = {
  id: "session-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  title: "Demo cast",
  status: "ready",
  script_asset_id: "script-asset-1",
  cover_asset_id: null,
  duration_ms: 1200,
  created_at: "2026-06-24T01:00:00.000Z",
  updated_at: "2026-06-24T01:00:01.000Z",
  deleted_at: null,
};

const exportRow = {
  id: "export-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  session_id: "session-1",
  asset_id: "asset-export-1",
  type: "mp4",
  label: "MP4",
  mime_type: "video/mp4",
  bytes: 42,
  created_at: "2026-06-24T02:00:00.000Z",
  deleted_at: null,
};

describe("SupabaseCastService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
  });

  it("creates owner-scoped cast sessions", async () => {
    const builder = makeBuilder({ data: sessionRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCastService().createSession({
      sceneId: "scene-1",
      title: "Demo cast",
      durationMs: 1200,
    });

    expect(result).toMatchObject({
      id: "session-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
    });
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((call) => call.method === "insert")?.args[0]).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      title: "Demo cast",
      status: "draft",
      script_asset_id: null,
      cover_asset_id: null,
      duration_ms: 1200,
      deleted_at: null,
    });
  });

  it("lists sessions by scene with a bounded limit", async () => {
    const builder = makeBuilder({ data: [sessionRow], error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCastService().listByScene("scene-1", {
      limit: 5,
    });

    expect(result).toHaveLength(1);
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["scene_id", "scene-1"] },
        { method: "is", args: ["deleted_at", null] },
        { method: "limit", args: [5] },
      ]),
    );
  });

  it("attaches a playback script and marks the session ready", async () => {
    const builder = makeBuilder({ data: sessionRow, error: null });
    mockFrom.mockReturnValue(builder);

    await createSupabaseCastService().attachScript("session-1", {
      scriptAssetId: "script-asset-1",
      durationMs: 1200,
    });

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((call) => call.method === "update")?.args[0]).toEqual({
      status: "ready",
      script_asset_id: "script-asset-1",
      duration_ms: 1200,
    });
    expect(calls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["id", "session-1"] }]),
    );
  });

  it("registers exports and marks the session exported", async () => {
    const exportBuilder = makeBuilder({ data: exportRow, error: null });
    const sessionBuilder = makeBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(exportBuilder)
      .mockReturnValueOnce(sessionBuilder);

    const result = await createSupabaseCastService().registerExport({
      sceneId: "scene-1",
      sessionId: "session-1",
      assetId: "asset-export-1",
      type: "mp4",
      label: "MP4",
      mimeType: "video/mp4",
      bytes: 42,
    });

    expect(result.id).toBe("export-1");
    expect(
      (
        exportBuilder as {
          __calls: Array<{ method: string; args: unknown[] }>;
        }
      ).__calls.find((call) => call.method === "insert")?.args[0],
    ).toMatchObject({
      owner_id: "owner-1",
      scene_id: "scene-1",
      session_id: "session-1",
      asset_id: "asset-export-1",
    });
    expect(
      (
        sessionBuilder as {
          __calls: Array<{ method: string; args: unknown[] }>;
        }
      ).__calls.find((call) => call.method === "update")?.args[0],
    ).toEqual({ status: "exported" });
  });

  it("lists exports by scene", async () => {
    const builder = makeBuilder({ data: [exportRow], error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCastService().listExportsByScene(
      "scene-1",
    );

    expect(result).toHaveLength(1);
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["scene_id", "scene-1"] },
        { method: "is", args: ["deleted_at", null] },
      ]),
    );
  });

  it("soft-deletes exports before the session", async () => {
    const exportBuilder = makeBuilder({ data: null, error: null });
    const sessionBuilder = makeBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(exportBuilder)
      .mockReturnValueOnce(sessionBuilder);

    await createSupabaseCastService().remove("session-1");

    expect(mockFrom).toHaveBeenNthCalledWith(1, "cast_exports");
    expect(mockFrom).toHaveBeenNthCalledWith(2, "cast_sessions");
    expect(
      (
        exportBuilder as {
          __calls: Array<{ method: string; args: unknown[] }>;
        }
      ).__calls.find((call) => call.method === "update")?.args[0],
    ).toHaveProperty("deleted_at");
    expect(
      (
        sessionBuilder as {
          __calls: Array<{ method: string; args: unknown[] }>;
        }
      ).__calls.find((call) => call.method === "update")?.args[0],
    ).toMatchObject({ status: "archived" });
  });
});
