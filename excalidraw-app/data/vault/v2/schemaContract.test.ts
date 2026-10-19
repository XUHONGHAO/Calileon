import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(
    path.resolve("excalidraw-app/data/cloud/supabase", file),
    "utf8",
  );

const schema = read("schema_vault_v2.sql");
const rollback = read("schema_vault_v2_rollback.sql");
const smoke = read("schema_vault_v2_smoke.sql");
const readScript = (name: string) =>
  readFileSync(path.resolve("deploy/vault-self-hosted/scripts", name), "utf8");

const normalizeSql = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const getFunctionDefinition = (name: string) => {
  const match = schema.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    ),
  );
  expect(match, `missing SQL function ${name}`).not.toBeNull();
  return match![0];
};

const FUNCTIONS = [
  { name: "get_vault_v2_contract", signature: "()", definer: true },
  { name: "vault_protocol_of", signature: "(uuid)", definer: true },
  {
    name: "assert_vault_protocol",
    signature: "(uuid, smallint)",
    definer: true,
  },
  {
    name: "assert_vault_envelope_v2",
    signature: "(uuid, text, bigint, integer, integer, jsonb)",
    definer: false,
  },
  {
    name: "create_vault_v2",
    signature: "(uuid, text, timestamptz)",
    definer: true,
  },
  {
    name: "resolve_vault_capability_v2",
    signature: "(uuid, text)",
    definer: true,
  },
  { name: "load_vault_snapshot_v2", signature: "(uuid, text)", definer: true },
  {
    name: "cas_vault_snapshot_v2",
    signature: "(uuid, text, bigint, uuid, jsonb)",
    definer: true,
  },
  { name: "vault_snapshots_v1_guard", signature: "()", definer: true },
] as const;

describe("Vault v2 Supabase schema contract", () => {
  it("widens the protocol constraint and rollback restores v1-only", () => {
    expect(schema).toContain(
      "drop constraint if exists vaults_protocol_v1_check",
    );
    expect(normalizeSql(schema)).toContain(
      "check (protocol_version in (1, 2))",
    );
    expect(normalizeSql(rollback)).toContain(
      "add constraint vaults_protocol_v1_check check (protocol_version = 1)",
    );
    // Rollback must refuse instead of orphaning v2 Vaults under a v1 check.
    expect(rollback).toContain("Vault v2 rollback refused");
  });

  it.each(["vault_snapshot_chunks", "vault_snapshot_commits"])(
    "declares, locks down and rolls back %s",
    (table) => {
      expect(schema).toContain(`create table if not exists public.${table}`);
      expect(schema).toContain(
        `revoke all on table public.${table} from anon, authenticated`,
      );
      expect(rollback).toContain(`drop table if exists public.${table}`);
    },
  );

  it.each(FUNCTIONS)(
    "defines $name with a pinned search_path and rolls it back",
    ({ name, signature, definer }) => {
      const definition = getFunctionDefinition(name);
      expect(definition).toMatch(
        /set search_path = pg_catalog, public(?:, extensions)?/,
      );
      if (definer) {
        expect(definition).toContain("security definer");
      } else {
        expect(definition).not.toContain("security definer");
      }
      expect(rollback).toContain(
        `drop function if exists public.${name}${signature}`,
      );
      expect(normalizeSql(schema)).toContain(
        `revoke all on function public.${name}${signature}`,
      );
    },
  );

  it("exposes only the v2 RPC allowlist", () => {
    const grants = schema
      .split("\n")
      .filter((line) => /^grant execute on function/i.test(line.trim()))
      .map((line) => normalizeSql(line));
    expect(grants.sort()).toEqual(
      [
        "grant execute on function public.cas_vault_snapshot_v2(uuid, text, bigint, uuid, jsonb) to anon, authenticated;",
        "grant execute on function public.create_vault_v2(uuid, text, timestamptz) to authenticated;",
        "grant execute on function public.get_vault_v2_contract() to service_role;",
        "grant execute on function public.load_vault_snapshot_v2(uuid, text) to anon, authenticated;",
        "grant execute on function public.resolve_vault_capability_v2(uuid, text) to anon, authenticated, service_role;",
      ].sort(),
    );
  });

  it("makes snapshot CAS atomic, role-checked and idempotent", () => {
    const cas = getFunctionDefinition("cas_vault_snapshot_v2");
    expect(cas).toContain("for update");
    expect(cas.indexOf("for update")).toBeLessThan(
      cas.indexOf("resolve_vault_capability_internal"),
    );
    expect(cas).toContain("'editor'");
    expect(cas).toContain("VAULT_SNAPSHOT_CONFLICT");
    expect(cas).toContain("sha256");
  });

  it("sorts envelope keys bytewise, independent of the database collation", () => {
    expect(getFunctionDefinition("assert_vault_envelope_v2")).toContain(
      'order by key collate "C"',
    );
  });

  it("blocks v1 snapshot writes to v2 Vaults idempotently", () => {
    expect(schema).toContain(
      "drop trigger if exists vault_snapshots_v1_guard on public.vault_snapshots",
    );
    expect(rollback).toContain(
      "drop trigger if exists vault_snapshots_v1_guard on public.vault_snapshots",
    );
  });

  it("smoke-tests the security-relevant paths and leaves no fixtures", () => {
    for (const message of [
      "viewer unexpectedly wrote v2 snapshot",
      "partial v2 snapshot became visible",
      "duplicate v2 CAS did not return the original confirmation",
      "same snapshot ID with different ciphertext unexpectedly succeeded",
      "stale v2 CAS unexpectedly succeeded",
      "v2 load unexpectedly read a v1 Vault",
      "v1 CAS unexpectedly wrote a v2 Vault",
      "internal Vault v2 helper or table is externally accessible",
    ]) {
      expect(smoke).toContain(message);
    }
    expect(normalizeSql(smoke)).toMatch(/rollback;\s*$/);
  });

  it("wires v2 into the self-hosted install, smoke and rollback scripts", () => {
    const install = readScript("install-schema.sh");
    expect(install.indexOf("/schema/schema_vault_v2.sql")).toBeGreaterThan(
      install.indexOf("/schema/schema_vault.sql"),
    );
    expect(readScript("schema-smoke.sh")).toContain(
      "/schema/schema_vault_v2_smoke.sql",
    );
    const roll = readScript("rollback-schema.sh");
    expect(roll.indexOf("schema_vault_v2_rollback.sql")).toBeGreaterThan(-1);
    expect(roll.indexOf("schema_vault_v2_rollback.sql")).toBeLessThan(
      roll.indexOf("/schema/schema_vault_rollback.sql"),
    );
  });
});
