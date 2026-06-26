import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseCollabRoomService } from "./SupabaseCollabRoomService";

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
  builder.maybeSingle = (...args: unknown[]) => {
    calls.push({ method: "maybeSingle", args });
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

const roomRow = {
  id: "binding-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  room_id: "room-1",
  status: "active",
  created_at: "2026-06-25T01:00:00.000Z",
  updated_at: "2026-06-25T01:00:01.000Z",
  revoked_at: null,
};

describe("SupabaseCollabRoomService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
  });

  it("creates owner-scoped room bindings without storing room keys", async () => {
    const builder = makeBuilder({ data: roomRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCollabRoomService().createForScene({
      sceneId: "scene-1",
      roomId: "room-1",
    });

    expect(result).toMatchObject({
      id: "binding-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      roomId: "room-1",
    });
    expect(
      (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls.find((call) => call.method === "insert")?.args[0],
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      room_id: "room-1",
      status: "active",
    });
  });

  it("gets the active room by scene", async () => {
    const builder = makeBuilder({ data: roomRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCollabRoomService().getByScene(
      "scene-1",
    );

    expect(result?.roomId).toBe("room-1");
    expect(
      (builder as { __calls: Array<{ method: string; args: unknown[] }> })
        .__calls,
    ).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["scene_id", "scene-1"] },
        { method: "eq", args: ["status", "active"] },
        { method: "is", args: ["revoked_at", null] },
        { method: "limit", args: [1] },
      ]),
    );
  });

  it("gets the active room by room id", async () => {
    const builder = makeBuilder({ data: roomRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCollabRoomService().getByRoomId(
      "room-1",
    );

    expect(result?.sceneId).toBe("scene-1");
    expect(
      (builder as { __calls: Array<{ method: string; args: unknown[] }> })
        .__calls,
    ).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["room_id", "room-1"] },
        { method: "eq", args: ["status", "active"] },
        { method: "is", args: ["revoked_at", null] },
      ]),
    );
  });

  it("revokes room bindings", async () => {
    const builder = makeBuilder({ data: null, error: null });
    mockFrom.mockReturnValue(builder);

    await createSupabaseCollabRoomService().revoke("binding-1");

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((call) => call.method === "update")?.args[0]).toEqual(
      expect.objectContaining({
        status: "revoked",
      }),
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["id", "binding-1"] },
        { method: "eq", args: ["status", "active"] },
      ]),
    );
  });

  it("touches active room bindings", async () => {
    const builder = makeBuilder({ data: roomRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseCollabRoomService().touch("binding-1");

    expect(result.id).toBe("binding-1");
    expect(
      (builder as { __calls: Array<{ method: string; args: unknown[] }> })
        .__calls,
    ).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["id", "binding-1"] },
        { method: "eq", args: ["status", "active"] },
        { method: "is", args: ["revoked_at", null] },
      ]),
    );
  });
});
