import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { VAULT_RPC } from "./backendContract";

const schema = readFileSync(
  path.resolve("excalidraw-app/data/cloud/supabase/schema_vault.sql"),
  "utf8",
);
const prerequisites = readFileSync(
  path.resolve(
    "excalidraw-app/data/cloud/supabase/schema_vault_prerequisites.sql",
  ),
  "utf8",
);
const rollback = readFileSync(
  path.resolve("excalidraw-app/data/cloud/supabase/schema_vault_rollback.sql"),
  "utf8",
);
const smoke = readFileSync(
  path.resolve("excalidraw-app/data/cloud/supabase/schema_vault_smoke.sql"),
  "utf8",
);
const backupScript = readFileSync(
  path.resolve("deploy/vault-self-hosted/scripts/backup.ps1"),
  "utf8",
);
const restoreScript = readFileSync(
  path.resolve("deploy/vault-self-hosted/scripts/restore.ps1"),
  "utf8",
);

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

describe("Vault Supabase F2 schema contract", () => {
  it("pins the F4 deployment and schema compatibility contract", () => {
    expect(schema).toContain(
      "create table if not exists public.vault_deployment_metadata",
    );
    expect(schema).toContain("deployment_version = 'p4a-f4-v1'");
    expect(schema).toContain("schema_version = 1");
    expect(schema).toContain("function public.get_vault_deployment_contract()");
    expect(schema).toContain(
      "grant execute on function public.get_vault_deployment_contract() to service_role",
    );
    expect(rollback).toContain(
      "drop table if exists public.vault_deployment_metadata",
    );
    expect(smoke).toContain("unexpected Vault deployment contract");
  });

  it.each(["vaults", "vault_invitations", "vault_snapshots", "vault_assets"])(
    "declares and rolls back %s independently",
    (table) => {
      expect(schema).toContain(`create table if not exists public.${table}`);
      expect(rollback).toContain(`drop table if exists public.${table}`);
      expect(smoke).toContain(`('${table}')`);
    },
  );

  it("keeps the TypeScript RPC registry aligned with SQL", () => {
    for (const rpc of Object.values(VAULT_RPC)) {
      expect(schema).toContain(`function public.${rpc}(`);
      expect(smoke).toContain(`${rpc}(`);
    }
  });

  it("does not authorize asset storage by Vault ID alone", () => {
    expect(schema).not.toMatch(/create policy[\s\S]+vault\//i);
    expect(schema).toContain("short-lived scoped upload or");
    expect(schema).toContain(
      "grant execute on function public.complete_vault_asset(uuid, text, text, text, bigint) to service_role",
    );
    expect(schema).not.toContain(
      "grant execute on function public.complete_vault_asset(uuid, text, text, text, bigint) to anon",
    );
  });

  it("requires a capability for every persistence RPC", () => {
    expect(schema).not.toMatch(
      /function public\.load_vault_snapshot\(\s*p_vault_id uuid\s*\)/i,
    );
    expect(schema).not.toMatch(
      /function public\.cas_vault_snapshot\(\s*p_vault_id uuid,\s*p_expected_generation/i,
    );
    expect(schema).not.toMatch(
      /function public\.register_vault_asset\(\s*p_vault_id uuid,\s*p_file_id/i,
    );

    for (const rpc of [
      VAULT_RPC.loadSnapshot,
      VAULT_RPC.casSnapshot,
      VAULT_RPC.registerAsset,
      VAULT_RPC.completeAsset,
      VAULT_RPC.resolveAsset,
    ]) {
      expect(getFunctionDefinition(rpc)).toContain("p_capability text");
    }
    expect(smoke).toContain(
      "Vault ID-only persistence overload must not exist",
    );
    expect(smoke).toContain(
      "ID plus invalid capability unexpectedly loaded Vault",
    );
  });

  it("stores only domain-separated capability hashes", () => {
    const invitationTable = schema.match(
      /create table if not exists public\.vault_invitations \([\s\S]*?\n\);/i,
    )?.[0];
    expect(invitationTable).toBeDefined();
    expect(invitationTable).toContain("capability_hash");
    expect(invitationTable).not.toMatch(/\bcapability\s+text\b/i);
    expect(invitationTable).not.toMatch(/\b(content|root|room)_key\b/i);
    expect(getFunctionDefinition("vault_capability_hash")).toContain(
      "excalidraw-vault-capability",
    );
    expect(getFunctionDefinition("vault_capability_hash")).toContain(
      "decode('00', 'hex')",
    );
    expect(getFunctionDefinition("vault_capability_hash")).not.toContain(
      "chr(0)",
    );
    expect(smoke).toContain("raw Vault capability/key column exists");
  });

  it("enforces viewer/editor, expiry, revoke, and CAS contracts", () => {
    const resolution = getFunctionDefinition(
      "resolve_vault_capability_internal",
    );
    expect(resolution).toContain("for share");
    expect(resolution).not.toMatch(/\blanguage plpgsql\s+stable\b/i);
    expect(resolution).toContain("VAULT_CAPABILITY_EXPIRED");
    expect(resolution).toContain("VAULT_CAPABILITY_REVOKED");
    expect(resolution).toContain("p_required_role = 'editor'");

    const cas = getFunctionDefinition(VAULT_RPC.casSnapshot);
    expect(cas).toContain("for update");
    expect(cas.indexOf("for update")).toBeLessThan(
      cas.indexOf("resolve_vault_capability_internal"),
    );
    expect(cas).toContain("v_invitation.role <> 'editor'");
    expect(cas).toContain("VAULT_SNAPSHOT_CONFLICT");
    expect(cas).toContain("snapshot_generation = v_new_generation");

    expect(smoke).toContain("viewer unexpectedly wrote snapshot");
    expect(smoke).toContain("expired capability unexpectedly loaded snapshot");
    expect(smoke).toContain("revoked capability unexpectedly loaded snapshot");
    expect(smoke).toContain("stale editor CAS unexpectedly won");
    expect(smoke).toContain("new read succeeded after owner revoke");
  });

  it("keeps asset registration authorized, idempotent, and conflict-stable", () => {
    const register = getFunctionDefinition(VAULT_RPC.registerAsset);
    expect(register).toContain(
      "resolve_vault_capability_internal(p_vault_id, p_capability, 'editor')",
    );
    expect(register).toContain("on conflict (vault_id, file_id) do nothing");
    expect(register).toContain("VAULT_ASSET_CONFLICT");

    const resolve = getFunctionDefinition(VAULT_RPC.resolveAsset);
    expect(resolve).toContain("state = 'ready'");
    expect(smoke).toContain("viewer unexpectedly registered asset");
    expect(smoke).toContain("asset digest conflict unexpectedly succeeded");
    expect(smoke).toContain("anon unexpectedly completed asset");
  });

  it("limits SECURITY DEFINER search paths and exposes only RPCs", () => {
    for (const name of [
      "resolve_vault_capability_internal",
      ...Object.values(VAULT_RPC),
    ]) {
      const definition = getFunctionDefinition(name);
      expect(definition).toContain("security definer");
      expect(definition).toMatch(
        /set search_path = pg_catalog, public(?:, extensions)?/,
      );
    }

    for (const table of [
      "vaults",
      "vault_invitations",
      "vault_snapshots",
      "vault_assets",
    ]) {
      expect(schema).toContain(
        `revoke all on table public.${table} from anon, authenticated`,
      );
    }
    for (const helper of [
      "vault_capability_hash(uuid, text)",
      "vault_base64url_decode(text)",
      "assert_vault_envelope_v1(uuid, text, text, bigint, jsonb)",
      "resolve_vault_capability_internal(uuid, text, text)",
    ]) {
      expect(schema).toContain(`revoke all on function public.${helper}`);
    }
    expect(schema).toContain(
      "grant execute on function public.complete_vault_asset(uuid, text, text, text, bigint) to service_role",
    );
    expect(schema).not.toMatch(
      /grant execute on function public\.complete_vault_asset\([^)]+\) to (?:anon|authenticated)/i,
    );
    expect(smoke).toContain("unsafe SECURITY DEFINER/search_path");
    expect(smoke).toContain("internal Vault helper is externally executable");
  });

  it("clears automatic Data API function grants before the exact allowlist", () => {
    const normalizedSchema = normalizeSql(schema);
    const revokeRoles = "from public, anon, authenticated, service_role;";
    for (const signature of [
      "get_vault_deployment_contract()",
      "vault_capability_hash(uuid, text)",
      "vault_base64url_decode(text)",
      "assert_vault_envelope_v1(uuid, text, text, bigint, jsonb)",
      "resolve_vault_capability_internal(uuid, text, text)",
      "create_vault(uuid, smallint, text, timestamptz)",
      "activate_vault(uuid, text)",
      "fail_vault_creation(uuid)",
      "create_vault_invitation(uuid, text, text, timestamptz)",
      "resolve_vault_capability(uuid, text)",
      "load_vault_snapshot(uuid, text)",
      "cas_vault_snapshot(uuid, text, bigint, jsonb, bigint)",
      "register_vault_asset(uuid, text, text, text, bigint)",
      "complete_vault_asset(uuid, text, text, text, bigint)",
      "resolve_vault_asset(uuid, text, text)",
      "revoke_vault_invitation(uuid, uuid)",
      "revoke_vault(uuid)",
      "soft_delete_vault(uuid)",
    ]) {
      expect(normalizedSchema).toContain(
        `revoke all on function public.${signature} ${revokeRoles}`,
      );
    }
    expect(normalizeSql(prerequisites)).toContain(
      `revoke all on function public.vault_touch_updated_at() ${revokeRoles}`,
    );
  });

  it("preserves Supabase ownership and ACLs in the F4 backup format", () => {
    expect(backupScript).toContain('backupFormat = "supabase-full-v1"');
    expect(backupScript).toContain("preservesOwnershipAndPrivileges = $true");
    expect(backupScript).not.toMatch(/--no-owner|--no-privileges/);
    expect(restoreScript).not.toMatch(/--no-owner|--no-privileges/);
    expect(restoreScript).toContain("restore-preflight.sql");
    expect(restoreScript).toContain("restore-disable-event-triggers.sql");
    expect(restoreScript).toContain("sh /ops/install-schema.sh");
    expect(restoreScript).toContain("sh /ops/schema-smoke.sh");
  });

  it("rolls back only the isolated Vault path without plaintext migration", () => {
    expect(rollback).not.toMatch(
      /\b(?:insert into|update|copy|create table|alter table)\b/i,
    );
    expect(rollback).not.toMatch(
      /\b(?:collab_room|cloud_scene|firebase|legacy_scene)\b/i,
    );

    const executableLines = rollback
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"));
    expect(executableLines.every((line) => line.startsWith("drop "))).toBe(
      true,
    );
  });
});
