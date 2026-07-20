import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const target = process.argv[2] || "local";
const envFileArgument = process.argv[3] || "";

if (!new Set(["local", "remote"]).has(target)) {
  throw new Error("Retention gate target must be local or remote.");
}

const quietExec = (file, args, options = {}) => {
  const usesWindowsShim =
    process.platform === "win32" && ["supabase", "psql"].includes(file);
  if (
    usesWindowsShim &&
    args.some((argument) => !/^[A-Za-z0-9._:=/\\-]+$/.test(argument))
  ) {
    throw new Error("Refusing an unsafe Windows command-shim argument.");
  }
  return execFileSync(
    usesWindowsShim ? process.env.ComSpec || "cmd.exe" : file,
    usesWindowsShim
      ? ["/d", "/s", "/c", file + ".cmd " + args.join(" ")]
      : args,
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...options,
    },
  );
};

const importEnvironment = (path) => {
  if (!path) {
    return;
  }
  const absolutePath = isAbsolute(path) ? path : resolve(repoRoot, path);
  quietExec("git", ["check-ignore", "--quiet", "--", absolutePath]);
  for (const line of readFileSync(absolutePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!assignment) {
      throw new Error("Vault environment file contains an invalid assignment.");
    }
    let value = assignment[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[assignment[1]] = value;
  }
};

const defaultEnvFile =
  target === "remote" ? resolve(scriptDirectory, "remote.local.env") : "";
importEnvironment(envFileArgument || defaultEnvFile);

let apiUrl;
let serviceRoleKey;
let databaseUrl;
let sslRootCert = "";

if (target === "local") {
  const status = JSON.parse(
    quietExec("supabase", ["status", "--output", "json"]),
  );
  apiUrl = status.API_URL;
  serviceRoleKey = status.SERVICE_ROLE_KEY;
  databaseUrl = new URL(
    process.env.VAULT_LOCAL_DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  );
} else {
  const projectRef = process.env.VAULT_SUPABASE_PROJECT_REF;
  if (
    !/^[a-z0-9]{20}$/.test(projectRef || "") ||
    process.env.VAULT_REMOTE_CONFIRM_PROJECT_REF !== projectRef ||
    process.env.VAULT_REMOTE_CONFIRM_DISPOSABLE !== "DISPOSABLE_TEST_PROJECT"
  ) {
    throw new Error("Remote disposable-project confirmation is invalid.");
  }
  quietExec("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve(scriptDirectory, "remote.ps1"),
    "-Action",
    "preflight",
    "-EnvFile",
    envFileArgument || defaultEnvFile,
  ]);
  const apiKeys = JSON.parse(
    quietExec("supabase", [
      "projects",
      "api-keys",
      "--project-ref",
      projectRef,
      "--reveal",
      "--output",
      "json",
      "--log-level",
      "error",
    ]),
  );
  serviceRoleKey = apiKeys.find(
    (candidate) => candidate.name === "service_role",
  )?.api_key;
  apiUrl = "https://" + projectRef + ".supabase.co";
  if (!process.env.VAULT_SUPABASE_DB_URL) {
    throw new Error("VAULT_SUPABASE_DB_URL is required for the remote gate.");
  }
  databaseUrl = new URL(process.env.VAULT_SUPABASE_DB_URL);
  sslRootCert = process.env.VAULT_SUPABASE_SSLROOTCERT_PATH || "";
  if (!sslRootCert || !isAbsolute(sslRootCert)) {
    throw new Error("Remote SSL root certificate path must be absolute.");
  }
}

if (!apiUrl || !serviceRoleKey) {
  throw new Error("Supabase did not expose required in-memory service values.");
}

const psqlEnvironment = {
  ...process.env,
  PGHOST: databaseUrl.hostname,
  PGPORT: databaseUrl.port,
  PGUSER: decodeURIComponent(databaseUrl.username),
  PGPASSWORD: decodeURIComponent(databaseUrl.password),
  PGDATABASE: databaseUrl.pathname.slice(1),
  PGSSLMODE: target === "remote" ? "verify-full" : "disable",
  PGSSLROOTCERT: target === "remote" ? sslRootCert : "",
  PGCONNECT_TIMEOUT: "10",
};

const runSql = (sql) => {
  try {
    quietExec("psql", ["-X", "--set=ON_ERROR_STOP=1", "--quiet"], {
      input: sql,
      env: psqlEnvironment,
    });
  } catch {
    throw new Error("Vault " + target + " retention SQL gate failed.");
  }
};

const sqlLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("base64url");

const vaultId = randomUUID();
const ownerId = randomUUID();
const invitationId = randomUUID();
const capability = randomBytes(32).toString("base64url");
const fileId = "asset_" + randomBytes(12).toString("base64url");
const storagePath = "vault/" + vaultId + "/" + fileId;
const snapshotEnvelope = JSON.stringify({
  version: 1,
  vaultId,
  purpose: "snapshot",
  messageType: "snapshot.scene",
  messageId: randomUUID(),
  generation: 1,
  iv: randomBytes(12).toString("base64url"),
  ciphertext: "AQ",
});
const assetEnvelope = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    vaultId,
    purpose: "asset",
    messageType: "asset.content",
    messageId: randomUUID(),
    iv: randomBytes(12).toString("base64url"),
    ciphertext: "AQ",
  }),
);
const assetDigest = digest(assetEnvelope);
const serviceClient = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

let databaseFixtureCreated = false;
let storageObjectCreated = false;

const setupSql = [
  "begin;",
  "insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)",
  "values (" +
    sqlLiteral(ownerId) +
    ", 'authenticated', 'authenticated', " +
    sqlLiteral("vault-retention-" + ownerId + "@example.invalid") +
    ", '', now(), now());",
  "insert into public.vaults",
  "  (id, owner_id, state, protocol_version, active_room_id, snapshot_generation)",
  "values (" +
    sqlLiteral(vaultId) +
    ", " +
    sqlLiteral(ownerId) +
    ", 'active', 1, " +
    sqlLiteral("room_" + randomBytes(12).toString("base64url")) +
    ", 1);",
  "insert into public.vault_invitations",
  "  (id, vault_id, role, capability_hash, authorization_version, created_by, expires_at)",
  "values (" +
    sqlLiteral(invitationId) +
    ", " +
    sqlLiteral(vaultId) +
    ", 'editor', public.vault_capability_hash(" +
    sqlLiteral(vaultId) +
    ", " +
    sqlLiteral(capability) +
    "), 1, " +
    sqlLiteral(ownerId) +
    ", now() + interval '15 minutes');",
  "insert into public.vault_snapshots",
  "  (vault_id, generation, encrypted_envelope, ciphertext_bytes)",
  "values (" +
    sqlLiteral(vaultId) +
    ", 1, " +
    sqlLiteral(snapshotEnvelope) +
    "::jsonb, " +
    Buffer.byteLength(snapshotEnvelope) +
    ");",
  "insert into public.vault_assets",
  "  (vault_id, file_id, storage_path, encrypted_digest, ciphertext_bytes, state)",
  "values (" +
    sqlLiteral(vaultId) +
    ", " +
    sqlLiteral(fileId) +
    ", " +
    sqlLiteral(storagePath) +
    ", " +
    sqlLiteral(assetDigest) +
    ", " +
    assetEnvelope.byteLength +
    ", 'ready');",
  "commit;",
].join("\n");

const ownerDeleteSql = [
  "begin;",
  "select set_config('request.jwt.claim.sub', " +
    sqlLiteral(ownerId) +
    ", true);",
  "set local role authenticated;",
  "select public.revoke_vault(" + sqlLiteral(vaultId) + ");",
  "select public.soft_delete_vault(" + sqlLiteral(vaultId) + ");",
  "commit;",
].join("\n");

const retentionValidationSql = [
  "do $$",
  "begin",
  "  if not exists (",
  "    select 1 from public.vaults",
  "    where id = " + sqlLiteral(vaultId),
  "      and state = 'deleted'",
  "      and revoked_at is not null and deleted_at is not null",
  "      and delete_after between now() + interval '6 days 23 hours'",
  "        and now() + interval '7 days 1 hour'",
  "  ) then raise exception 'RETENTION_SOFT_DELETE_STATE_MISMATCH'; end if;",
  "  if not exists (",
  "    select 1 from public.vault_invitations",
  "    where id = " + sqlLiteral(invitationId),
  "      and revoked_at is not null and authorization_version = 2",
  "  ) then raise exception 'RETENTION_INVITATION_REVOCATION_MISMATCH'; end if;",
  "  if not exists (select 1 from public.vault_snapshots where vault_id = " +
    sqlLiteral(vaultId) +
    " and generation = 1)",
  "    or not exists (select 1 from public.vault_assets where vault_id = " +
    sqlLiteral(vaultId) +
    " and storage_path = " +
    sqlLiteral(storagePath) +
    " and state = 'ready')",
  "  then raise exception 'RETENTION_GRACE_ROWS_MISSING'; end if;",
  "end;",
  "$$;",
  "set role anon;",
  "do $$",
  "declare v_envelope jsonb := jsonb_build_object(",
  "  'version', 1, 'vaultId', " + sqlLiteral(vaultId) + ",",
  "  'purpose', 'snapshot', 'messageType', 'snapshot.scene',",
  "  'messageId', " + sqlLiteral(randomUUID()) + ", 'generation', 2,",
  "  'iv', 'AAAAAAAAAAAAAAAA', 'ciphertext', 'AQ');",
  "begin",
  "  begin",
  "    perform public.resolve_vault_capability(" +
    sqlLiteral(vaultId) +
    ", " +
    sqlLiteral(capability) +
    ");",
  "    raise exception 'RETENTION_RESOLVE_UNEXPECTEDLY_SUCCEEDED';",
  "  exception when sqlstate 'P0001' then",
  "    if sqlerrm <> 'VAULT_NOT_ACTIVE' then raise; end if;",
  "  end;",
  "  begin",
  "    perform public.cas_vault_snapshot(" +
    sqlLiteral(vaultId) +
    ", " +
    sqlLiteral(capability) +
    ", 1, v_envelope, 1);",
  "    raise exception 'RETENTION_CAS_UNEXPECTEDLY_SUCCEEDED';",
  "  exception when sqlstate 'P0001' then",
  "    if sqlerrm <> 'VAULT_NOT_ACTIVE' then raise; end if;",
  "  end;",
  "end;",
  "$$;",
  "reset role;",
].join("\n");

try {
  runSql(setupSql);
  databaseFixtureCreated = true;

  const upload = await serviceClient.storage
    .from("vault-assets")
    .upload(storagePath, assetEnvelope, {
      contentType: "application/octet-stream",
      upsert: false,
    });
  if (upload.error) {
    throw new Error("Encrypted retention fixture upload failed.");
  }
  storageObjectCreated = true;

  runSql(ownerDeleteSql);
  runSql(retentionValidationSql);

  const graceDownload = await serviceClient.storage
    .from("vault-assets")
    .download(storagePath);
  if (graceDownload.error) {
    throw new Error(
      "Encrypted Storage object disappeared during grace period.",
    );
  }
  const graceBytes = new Uint8Array(await graceDownload.data.arrayBuffer());
  if (!Buffer.from(graceBytes).equals(Buffer.from(assetEnvelope))) {
    throw new Error("Encrypted grace-period Storage object changed.");
  }

  runSql(
    [
      "update public.vaults set delete_after = now() - interval '1 second'",
      "where id = " + sqlLiteral(vaultId) + " and state = 'deleted';",
      "do $$ begin",
      "  if not exists (select 1 from public.vaults where id = " +
        sqlLiteral(vaultId) +
        " and state = 'deleted' and delete_after <= now())",
      "  then raise exception 'RETENTION_VAULT_NOT_DUE'; end if;",
      "end; $$;",
    ].join("\n"),
  );

  const removal = await serviceClient.storage
    .from("vault-assets")
    .remove([storagePath]);
  if (removal.error) {
    throw new Error("Due encrypted Storage object purge failed.");
  }
  const removedListing = await serviceClient.storage
    .from("vault-assets")
    .list("vault/" + vaultId, { search: fileId });
  if (
    removedListing.error ||
    removedListing.data.some((entry) => entry.name === fileId)
  ) {
    throw new Error("Purged Storage object remained listed.");
  }
  storageObjectCreated = false;

  runSql(
    [
      "do $$ begin",
      "  if exists (select 1 from storage.objects where bucket_id = 'vault-assets'",
      "    and name = " + sqlLiteral(storagePath) + ")",
      "  then raise exception 'RETENTION_STORAGE_ROW_REMAINED'; end if;",
      "end; $$;",
      "delete from public.vaults where id = " + sqlLiteral(vaultId),
      "  and state = 'deleted' and delete_after <= now();",
      "do $$ begin",
      "  if exists (select 1 from public.vaults where id = " +
        sqlLiteral(vaultId) +
        ")",
      "    or exists (select 1 from public.vault_invitations where vault_id = " +
        sqlLiteral(vaultId) +
        ")",
      "    or exists (select 1 from public.vault_snapshots where vault_id = " +
        sqlLiteral(vaultId) +
        ")",
      "    or exists (select 1 from public.vault_assets where vault_id = " +
        sqlLiteral(vaultId) +
        ")",
      "  then raise exception 'RETENTION_AGGREGATE_REMAINED'; end if;",
      "end; $$;",
      "delete from auth.users where id = " + sqlLiteral(ownerId) + ";",
    ].join("\n"),
  );
  databaseFixtureCreated = false;

  console.log(
    "PASS " +
      target +
      " soft delete revoked access and fixed delete_after near 7 days",
  );
  console.log(
    "PASS " +
      target +
      " capability resolve and snapshot CAS failed closed with VAULT_NOT_ACTIVE",
  );
  console.log(
    "PASS " +
      target +
      " encrypted snapshot, asset row, and Storage object survived the grace period",
  );
  console.log(
    "PASS " +
      target +
      " due Storage object and Vault aggregate were purged without plaintext fallback",
  );
  console.log(
    "NOTE this gate validates online DB/Storage lifecycle; " +
      "historical backup retention remains operator policy.",
  );
} finally {
  if (storageObjectCreated) {
    try {
      await serviceClient.storage.from("vault-assets").remove([storagePath]);
    } catch {
      // Preserve the primary gate failure while cleanup remains best-effort.
    }
  }
  if (databaseFixtureCreated) {
    try {
      runSql(
        [
          "delete from public.vaults where id = " + sqlLiteral(vaultId) + ";",
          "delete from auth.users where id = " + sqlLiteral(ownerId) + ";",
        ].join("\n"),
      );
    } catch {
      // Preserve the primary gate failure while cleanup remains best-effort.
    }
  }
}
