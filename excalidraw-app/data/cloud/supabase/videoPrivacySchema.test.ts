import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Static contract for ADR 0035: share and embed RPCs keep the owner's camera
// recordings out. The behaviour itself is exercised against Postgres by
// schema_video_privacy_smoke.sql.

const read = (file: string) =>
  readFileSync(
    path.resolve("excalidraw-app/data/cloud/supabase", file),
    "utf8",
  );

const normalizeSql = (value: string) =>
  value
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const getFunctionDefinition = (schema: string, name: string) => {
  const match = schema.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    ),
  );
  expect(match, `missing SQL function ${name}`).not.toBeNull();
  return normalizeSql(match![0]);
};

const CASES = [
  {
    file: "schema_shares.sql",
    load: "load_shared_scene",
    upsert: "upsert_shared_asset",
    error: "cloud-share-forbidden",
  },
  {
    file: "schema_embeds.sql",
    load: "load_embedded_scene",
    upsert: "upsert_embedded_asset",
    error: "cloud-embed-forbidden",
  },
];

describe("camera recordings stay out of share and embed RPCs", () => {
  it.each(CASES)("$load leaves video assets out", ({ file, load }) => {
    const fn = getFunctionDefinition(read(file), load);
    expect(fn).toContain("and a.deleted_at is null and a.type <> 'video'");
  });

  it.each(CASES)(
    "$upsert neither registers nor repoints a video",
    ({ file, upsert, error }) => {
      const fn = getFunctionDefinition(read(file), upsert);
      expect(fn).toContain(
        `if p_storage_path <> v_expected_path or p_type = 'video' then raise exception '${error}';`,
      );
      expect(fn).toContain(
        "where public.assets.type <> 'video' returning * into v_asset;",
      );
      expect(fn).toContain(
        `if not found then raise exception '${error}'; end if;`,
      );
    },
  );

  it("ships a rolled-back smoke wired into schema-smoke.sh", () => {
    const smoke = normalizeSql(read("schema_video_privacy_smoke.sql"));
    expect(smoke).toMatch(/^begin;/);
    expect(smoke).toContain("select 'video privacy smoke: pass' as result;");
    expect(smoke).toMatch(/rollback;$/);
    const script = readFileSync(
      path.resolve("deploy/vault-self-hosted/scripts/schema-smoke.sh"),
      "utf8",
    );
    expect(script).toContain("/schema/schema_video_privacy_smoke.sql");
  });
});
