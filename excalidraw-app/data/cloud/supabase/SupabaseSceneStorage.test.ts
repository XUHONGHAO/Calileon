import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseSceneStorage } from "./SupabaseSceneStorage";

import type { SceneRecord } from "../types";

/**
 * A minimal chainable PostgREST query-builder mock. Every chain method returns
 * the same builder; the builder is thenable (for chains awaited directly, e.g.
 * rename/remove/list) and `.single()` returns a promise — both resolve to the
 * configured `result`. `calls` records the chain so tests can assert behavior.
 */
const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ["insert", "update", "select", "eq", "is", "order"]) {
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

const baseScene: SceneRecord = {
  id: null,
  ownerId: "owner-1",
  title: "Board",
  payloadKind: "plain",
  payload: { type: "excalidraw", elements: [] },
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

describe("SupabaseSceneStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("save", () => {
    it("inserts when id is null, stamping owner from the session", async () => {
      signedIn();
      const builder = makeBuilder({
        data: { id: "new-id", version: 1 },
        error: null,
      });
      mockFrom.mockReturnValue(builder);

      const result = await createSupabaseSceneStorage().save(baseScene);

      expect(result).toEqual({ id: "new-id", version: 1 });
      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const insert = calls.find((c) => c.method === "insert");
      expect((insert?.args[0] as { owner_id: string }).owner_id).toBe(
        "owner-1",
      );
    });

    it("updates with a bumped version when id is present", async () => {
      const builder = makeBuilder({
        data: { id: "scene-1", version: 6 },
        error: null,
      });
      mockFrom.mockReturnValue(builder);

      const result = await createSupabaseSceneStorage().save({
        ...baseScene,
        id: "scene-1",
        version: 5,
      });

      expect(result).toEqual({ id: "scene-1", version: 6 });
      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const update = calls.find((c) => c.method === "update");
      expect((update?.args[0] as { version: number }).version).toBe(6);
      // update path must NOT need a fresh getUser call
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it("requires a session for insert → 'unauthorized'", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
      mockFrom.mockReturnValue(makeBuilder({ data: null, error: null }));

      const promise = createSupabaseSceneStorage().save(baseScene);
      await expect(promise).rejects.toBeInstanceOf(BackendError);
      await promise.catch((e) =>
        expect((e as BackendError).code).toBe("unauthorized"),
      );
    });

    it("maps an RLS denial (42501) to 'forbidden'", async () => {
      const builder = makeBuilder({
        data: null,
        error: { code: "42501", message: "rls" },
      });
      mockFrom.mockReturnValue(builder);

      const promise = createSupabaseSceneStorage().save({
        ...baseScene,
        id: "scene-1",
        version: 1,
      });
      await expect(promise).rejects.toBeInstanceOf(BackendError);
      await promise.catch((e) =>
        expect((e as BackendError).code).toBe("forbidden"),
      );
    });
  });

  describe("load", () => {
    it("returns a mapped SceneRecord excluding soft-deleted", async () => {
      const builder = makeBuilder({
        data: {
          id: "scene-1",
          owner_id: "owner-1",
          title: "Board",
          payload_kind: "plain",
          payload: { a: 1 },
          version: 2,
          thumbnail_meta: null,
          created_at: "2026-06-20T10:00:00.000Z",
          updated_at: "2026-06-20T10:00:00.000Z",
          deleted_at: null,
        },
        error: null,
      });
      mockFrom.mockReturnValue(builder);

      const record = await createSupabaseSceneStorage().load("scene-1");
      expect(record.id).toBe("scene-1");
      expect(record.payloadKind).toBe("plain");

      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      expect(
        calls.some((c) => c.method === "is" && c.args[0] === "deleted_at"),
      ).toBe(true);
    });
  });

  describe("list", () => {
    it("orders by updated_at desc and maps summaries", async () => {
      const builder = makeBuilder({
        data: [
          {
            id: "a",
            title: "A",
            version: 1,
            updated_at: "2026-06-20T10:00:00.000Z",
            thumbnail_meta: null,
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValue(builder);

      const summaries = await createSupabaseSceneStorage().list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ id: "a", title: "A", version: 1 });

      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const order = calls.find((c) => c.method === "order");
      expect(order?.args).toEqual(["updated_at", { ascending: false }]);
    });
  });

  describe("getMetadata", () => {
    it("loads lightweight scene metadata without the payload", async () => {
      const builder = makeBuilder({
        data: {
          id: "scene-1",
          title: "Board",
          version: 4,
          updated_at: "2026-06-20T10:00:00.000Z",
          thumbnail_meta: null,
        },
        error: null,
      });
      mockFrom.mockReturnValue(builder);

      const metadata = await createSupabaseSceneStorage().getMetadata(
        "scene-1",
      );
      expect(metadata).toMatchObject({
        id: "scene-1",
        title: "Board",
        version: 4,
      });

      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const select = calls.find((c) => c.method === "select");
      expect(select?.args[0]).toBe(
        "id,title,version,updated_at,thumbnail_meta",
      );
      expect(calls.some((c) => c.method === "single")).toBe(true);
    });
  });

  describe("rename", () => {
    it("updates only the title on a non-deleted row", async () => {
      const builder = makeBuilder({ error: null });
      mockFrom.mockReturnValue(builder);

      await createSupabaseSceneStorage().rename("scene-1", "Renamed");

      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const update = calls.find((c) => c.method === "update");
      expect(update?.args[0]).toEqual({ title: "Renamed" });
    });
  });

  describe("remove", () => {
    it("soft-deletes by setting deleted_at", async () => {
      const builder = makeBuilder({ error: null });
      mockFrom.mockReturnValue(builder);

      await createSupabaseSceneStorage().remove("scene-1");

      const calls = (
        builder as { __calls: Array<{ method: string; args: unknown[] }> }
      ).__calls;
      const update = calls.find((c) => c.method === "update");
      expect(update?.args[0]).toHaveProperty("deleted_at");
    });
  });
});
