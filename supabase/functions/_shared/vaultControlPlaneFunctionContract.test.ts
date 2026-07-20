import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve("supabase/functions/vault-control-plane/index.ts"),
  "utf8",
);
const config = readFileSync(path.resolve("supabase/config.toml"), "utf8");

describe("vault-control-plane Edge Function contract", () => {
  it("publishes discovery without requiring a JWT but authenticates mutations", () => {
    expect(config).toMatch(
      /\[functions\.vault-control-plane\]\s+verify_jwt = false/,
    );
    expect(source).toContain('request.method === "GET"');
    expect(source).toContain("createUserClient(request)");
    expect(source).toContain("userClient.auth.getUser()");
  });

  it("advertises Vault only when the trusted room control plane is configured", () => {
    expect(source).toContain('Deno.env.get("VAULT_ROOM_CONTROL_PLANE_URL")');
    expect(source).toContain('Deno.env.get("VAULT_ROOM_CONTROL_PLANE_TOKEN")');
    expect(source).toContain("getRoomControlPlane() !== null &&");
    expect(source).toContain('"get_vault_deployment_contract"');
    expect(source).toContain('const DEPLOYMENT_VERSION = "p4a-f4-v1"');
    expect(source).toContain("schemaVersion");
    expect(source).toContain("encryptedSnapshotPersistence: enabled");
    expect(source).toContain("encryptedAssetPersistence: enabled");
  });

  it("revokes through the owner RPC before sending a secret-free disconnect notice", () => {
    const revoke = source.indexOf('userClient.rpc("revoke_vault_invitation"');
    const notify = source.indexOf("fetch(roomControlPlane.url");
    expect(revoke).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(revoke);
    expect(source).toContain('action !== "revoke-invitation"');
    expect(source).toContain("JSON.stringify(revocation)");
    expect(source).not.toMatch(
      /invitationCapability|rootKey|contentKey|console\./,
    );
  });

  it("accepts local Docker host routing only for HTTP development", () => {
    expect(source).toContain('"host.docker.internal"');
    expect(source).toContain('url.protocol !== "https:" && !isLocalHttp');
    expect(source).toContain("token.length < 32");
  });
});
