import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PostgresGatewayStore } from "../src/gateway/store.js";

describe("managed gateway Postgres migration contract", () => {
  it("is idempotent and creates the independent ai_gateway ledger", () => {
    const sql = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../migrations/0001_ai_gateway.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("create schema if not exists ai_gateway");
    expect(sql).toContain("create table if not exists ai_gateway.requests");
    expect(sql).toContain(
      "create table if not exists ai_gateway.audit_records",
    );
    expect(sql).toContain("on conflict (version) do nothing");
    expect(sql).toContain("token_hash text primary key");
  });

  it("reports readiness only after the migration marker is present", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ version: "0001_ai_gateway" }],
      rowCount: 1,
    });
    const pool = {
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    };
    const store = new PostgresGatewayStore("postgresql://unused", pool);
    await expect(store.checkReady()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("schema_migrations"),
      ["0001_ai_gateway"],
    );
    await store.close();
  });
});
