import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve("supabase/functions/vault-asset-access/index.ts"),
  "utf8",
);
const config = readFileSync(path.resolve("supabase/config.toml"), "utf8");

describe("vault-asset-access Edge Function contract", () => {
  it("uses capability auth instead of Supabase JWT admission", () => {
    expect(config).toContain("[functions.vault-asset-access]");
    expect(config).toMatch(
      /\[functions\.vault-asset-access\]\s+verify_jwt = false/,
    );
    expect(source).toContain('"resolve_vault_capability"');
    expect(source).toContain('"register_vault_asset"');
    expect(source).toContain('"resolve_vault_asset"');
    expect(source).toContain('"complete_vault_asset"');
  });

  it("validates the stored object before completing metadata", () => {
    const preflight = source.indexOf('"resolve_vault_capability"');
    const download = source.indexOf(".download(storagePath)");
    const envelope = source.indexOf("assertVaultAssetEnvelopeBytes(bytes");
    const digest = source.indexOf("sha256Base64Url(bytes)");
    const completion = source.indexOf('"complete_vault_asset"');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(download);
    expect(download).toBeLessThan(envelope);
    expect(envelope).toBeLessThan(digest);
    expect(digest).toBeLessThan(completion);
  });

  it("signs only the exact isolated Vault path without overwrite", () => {
    expect(source).toContain(
      'Deno.env.get("VAULT_ASSET_BUCKET") || "vault-assets"',
    );
    expect(source).toContain("getVaultAssetStoragePath(");
    expect(source).toContain(
      "createSignedUploadUrl(registration.storagePath, {",
    );
    expect(source).toContain("upsert: false");
    expect(source).toContain("createSignedUrl(");
    expect(source).not.toMatch(/create policy|storage\.objects/i);
  });

  it("returns only stable errors and no plaintext metadata", () => {
    expect(source).toContain("toStableVaultAssetErrorCode(error)");
    expect(source).toContain(
      "errorResponse(request, getVaultAssetErrorStatus(code), code)",
    );
    expect(source).not.toMatch(/console\.|filename|mime(?:type)?/i);
  });
});
