import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseSceneActivityService } from "./SupabaseSceneActivityService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ["insert", "select", "eq", "order", "limit"]) {
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
const mockGetUser = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const signedIn = () =>
  mockGetUser.mockResolvedValue({
    data: { user: { id: "owner-1" } },
    error: null,
  });

describe("SupabaseSceneActivityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates activity stamped with the current owner", async () => {
    signedIn();
    const builder = makeBuilder({
      data: {
        id: "activity-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        element_id: "element-1",
        actor_id: "owner-1",
        op_type: "update",
        summary: "Moved rectangle",
        created_at: "2026-06-23T10:00:00.000Z",
      },
      error: null,
    });
    mockFrom.mockReturnValue(builder);

    const record = await createSupabaseSceneActivityService().create({
      sceneId: "scene-1",
      elementId: "element-1",
      actorId: "owner-1",
      operation: "update",
      summary: "Moved rectangle",
    });

    expect(record).toMatchObject({
      id: "activity-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      operation: "update",
    });
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const insert = calls.find((c) => c.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      owner_id: "owner-1",
      scene_id: "scene-1",
      element_id: "element-1",
      actor_id: "owner-1",
      op_type: "update",
    });
  });

  it("requires a signed-in user for create", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockFrom.mockReturnValue(makeBuilder({ data: null, error: null }));

    const promise = createSupabaseSceneActivityService().create({
      sceneId: "scene-1",
      elementId: null,
      actorId: "anonymous",
      operation: "create",
      summary: null,
    });
    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await promise.catch((error) =>
      expect((error as BackendError).code).toBe("unauthorized"),
    );
  });

  it("lists activity for a scene newest first with a bounded limit", async () => {
    const builder = makeBuilder({
      data: [
        {
          id: "activity-1",
          owner_id: "owner-1",
          scene_id: "scene-1",
          element_id: null,
          actor_id: "owner-1",
          op_type: "create",
          summary: null,
          created_at: "2026-06-23T10:00:00.000Z",
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(builder);

    const records = await createSupabaseSceneActivityService().listByScene(
      "scene-1",
      { limit: 500 },
    );

    expect(records).toHaveLength(1);
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((c) => c.method === "eq")?.args).toEqual([
      "scene_id",
      "scene-1",
    ]);
    expect(calls.find((c) => c.method === "order")?.args).toEqual([
      "created_at",
      { ascending: false },
    ]);
    expect(calls.find((c) => c.method === "limit")?.args).toEqual([200]);
  });
});
