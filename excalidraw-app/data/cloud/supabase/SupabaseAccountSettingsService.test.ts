import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAccountSettingsService } from "./SupabaseAccountSettingsService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["insert", "update", "delete", "select", "eq"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  for (const method of ["single", "maybeSingle"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  }
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  (builder as { __calls: typeof calls }).__calls = calls;
  return builder;
};

const callsOf = (builder: Record<string, unknown>) =>
  (builder as { __calls: Array<{ method: string; args: unknown[] }> }).__calls;

const mockFrom = vi.fn();
const mockGetUser = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const kdf = {
  name: "PBKDF2",
  hash: "SHA-256",
  iterations: 600000,
  salt: "c2FsdHNhbHRzYWx0c2FsdA==",
} as const;

const row = {
  format_version: 1,
  kdf,
  iv: "aXZpdml2aXZpdml2",
  ciphertext: "Y2lwaGVy",
  // PostgREST returns bigint as a number or a string
  revision: "3",
  updated_at: "2026-10-27T01:00:00.000Z",
};

const write = {
  formatVersion: 1 as const,
  kdf,
  iv: row.iv,
  ciphertext: row.ciphertext,
};

describe("SupabaseAccountSettingsService (ADR 0038)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
  });

  it("maps the row and reports no row as null", async () => {
    const service = createSupabaseAccountSettingsService();
    mockFrom.mockReturnValueOnce(makeBuilder({ data: row, error: null }));
    expect(await service.get()).toEqual({
      formatVersion: 1,
      kdf,
      iv: row.iv,
      ciphertext: row.ciphertext,
      revision: 3,
      updatedAt: Date.parse(row.updated_at),
    });

    mockFrom.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    expect(await service.get()).toBeNull();
  });

  it("rejects rows it can't read", async () => {
    const service = createSupabaseAccountSettingsService();
    mockFrom.mockReturnValueOnce(
      makeBuilder({ data: { ...row, format_version: 2 }, error: null }),
    );
    await expect(service.get()).rejects.toMatchObject({ code: "conflict" });
  });

  it("creates revision 1 for the signed-in owner", async () => {
    const service = createSupabaseAccountSettingsService();
    const builder = makeBuilder({ data: { ...row, revision: 1 }, error: null });
    mockFrom.mockReturnValueOnce(builder);

    await service.put(write, null);

    const insert = callsOf(builder).find((call) => call.method === "insert");
    expect(insert?.args[0]).toEqual({
      format_version: 1,
      kdf,
      iv: row.iv,
      ciphertext: row.ciphertext,
      owner_id: "owner-1",
      revision: 1,
    });
  });

  it("maps a duplicate first insert to a conflict", async () => {
    const service = createSupabaseAccountSettingsService();
    mockFrom.mockReturnValueOnce(
      makeBuilder({ data: null, error: { code: "23505", message: "dup" } }),
    );
    await expect(service.put(write, null)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("updates only the expected revision and reports a stale one", async () => {
    const service = createSupabaseAccountSettingsService();
    const builder = makeBuilder({ data: { ...row, revision: 4 }, error: null });
    mockFrom.mockReturnValueOnce(builder);

    expect((await service.put(write, 3)).revision).toBe(4);
    const calls = callsOf(builder);
    expect(calls.find((call) => call.method === "update")?.args[0]).toEqual(
      expect.objectContaining({ revision: 4 }),
    );
    expect(
      calls.filter((call) => call.method === "eq").map((call) => call.args),
    ).toEqual([
      ["owner_id", "owner-1"],
      ["revision", 3],
    ]);

    mockFrom.mockReturnValueOnce(makeBuilder({ data: null, error: null }));
    await expect(service.put(write, 3)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("requires a signed-in user to write", async () => {
    const service = createSupabaseAccountSettingsService();
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(service.remove()).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
