import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const envFile = resolve(
  repoRoot,
  process.argv[2] || "scripts/vault/remote.local.env",
);

const quietExec = (file, args, options = {}) => {
  const usesWindowsShim =
    process.platform === "win32" && ["supabase", "psql"].includes(file);
  if (
    usesWindowsShim &&
    args.some((argument) => !/^[A-Za-z0-9._:=/-]+$/.test(argument))
  ) {
    throw new Error("Refusing an unsafe Windows command-shim argument.");
  }
  return execFileSync(
    usesWindowsShim ? process.env.ComSpec || "cmd.exe" : file,
    usesWindowsShim
      ? ["/d", "/s", "/c", `${file}.cmd ${args.join(" ")}`]
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
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!assignment) {
      throw new Error(
        "Remote environment file contains an invalid assignment.",
      );
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

quietExec("git", ["check-ignore", "--quiet", "--", envFile]);
importEnvironment(envFile);

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
  envFile,
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
const keyByName = (name) =>
  apiKeys.find((candidate) => candidate.name === name)?.api_key;
const anonKey = keyByName("anon");
const serviceRoleKey = keyByName("service_role");
if (!anonKey || !serviceRoleKey) {
  throw new Error("Hosted project did not expose required legacy API keys.");
}

const apiUrl = `https://${projectRef}.supabase.co`;
const functionUrl = `${apiUrl}/functions/v1/vault-asset-access`;
const databaseUrl = new URL(process.env.VAULT_SUPABASE_DB_URL);
const sslRootCert = process.env.VAULT_SUPABASE_SSLROOTCERT_PATH;
if (!sslRootCert || !isAbsolute(sslRootCert)) {
  throw new Error("Remote SSL root certificate path must be absolute.");
}

const psqlEnvironment = {
  ...process.env,
  PGHOST: databaseUrl.hostname,
  PGPORT: databaseUrl.port,
  PGUSER: decodeURIComponent(databaseUrl.username),
  PGPASSWORD: decodeURIComponent(databaseUrl.password),
  PGDATABASE: databaseUrl.pathname.slice(1),
  PGSSLMODE: "verify-full",
  PGSSLROOTCERT: sslRootCert,
  PGCONNECT_TIMEOUT: "10",
};
const runSql = (sql) => {
  quietExec("psql", ["-X", "--set=ON_ERROR_STOP=1", "--quiet"], {
    input: sql,
    env: psqlEnvironment,
  });
};

const vaultId = randomUUID();
const ownerId = randomUUID();
const editorInvitationId = randomUUID();
const viewerInvitationId = randomUUID();
// Capabilities are protocol tokens, not arbitrary labels: exactly 32 random
// bytes encoded as 43 base64url characters. The editor token doubles as the
// synthetic sentinel searched for in hosted logs.
const sentinel = randomBytes(32).toString("base64url");
const editorCapability = sentinel;
const viewerCapability = randomBytes(32).toString("base64url");
const wrongCapability = randomBytes(32).toString("base64url");
const fileIds = {
  valid: `asset_${randomBytes(12).toString("base64url")}`,
  large: `asset_${randomBytes(12).toString("base64url")}`,
  tampered: `asset_${randomBytes(12).toString("base64url")}`,
  digestMismatch: `asset_${randomBytes(12).toString("base64url")}`,
};

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("base64url");
const canonicalEnvelope = (messageId = randomUUID(), ciphertext = "AQ") =>
  new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      vaultId,
      purpose: "asset",
      messageType: "asset.content",
      messageId,
      iv: randomBytes(12).toString("base64url"),
      ciphertext,
    }),
  );

const callFunction = async (body, expectedStatus = 200) => {
  const response = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  const stableCode = result.error ?? result.code;
  if (response.status !== expectedStatus) {
    throw new Error(
      `Unexpected Edge status ${
        response.status
      }; expected ${expectedStatus}; code=${stableCode ?? "missing"}`,
    );
  }
  return { ...result, stableCode };
};

const expectCode = async (body, statusCode, errorCode) => {
  const result = await callFunction(body, statusCode);
  if (result.stableCode !== errorCode) {
    throw new Error(
      `Expected ${errorCode}; received ${result.stableCode ?? "missing"}.`,
    );
  }
};

const anonClient = createClient(apiUrl, anonKey, {
  auth: { persistSession: false },
});
const serviceClient = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const storagePaths = [];

const createAndUpload = async (
  fileId,
  bytes,
  declaredDigest = digest(bytes),
) => {
  const registration = await callFunction({
    action: "create-upload",
    vaultId,
    invitationCapability: editorCapability,
    fileId,
    encryptedDigest: declaredDigest,
    ciphertextBytes: bytes.byteLength,
  });
  if (registration.state !== "pending" || !registration.token) {
    throw new Error("Signed upload registration did not return pending/token.");
  }
  const expectedPath = `vault/${vaultId}/${fileId}`;
  if (registration.storagePath !== expectedPath) {
    throw new Error("Signed upload path escaped its Vault namespace.");
  }
  storagePaths.push(expectedPath);
  const { error } = await anonClient.storage
    .from("vault-assets")
    .uploadToSignedUrl(expectedPath, registration.token, bytes, {
      contentType: "application/json",
    });
  if (error) {
    throw new Error(
      `Signed upload failed with status ${error.status ?? "unknown"}.`,
    );
  }
  const second = await anonClient.storage
    .from("vault-assets")
    .uploadToSignedUrl(expectedPath, registration.token, bytes, {
      contentType: "application/json",
    });
  if (!second.error) {
    throw new Error("Signed upload unexpectedly allowed overwrite.");
  }
};

const logSources = [
  "edge_logs",
  "function_edge_logs",
  "postgrest_logs",
  "storage_logs",
  "postgres_logs",
];
const scanRemoteLogs = async (startedAt) => {
  const scannedSources = [];
  let scannedRows = 0;
  for (const source of logSources) {
    const endpoint = new URL(
      `https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs.all`,
    );
    endpoint.searchParams.set("iso_timestamp_start", startedAt.toISOString());
    endpoint.searchParams.set("iso_timestamp_end", new Date().toISOString());
    endpoint.searchParams.set(
      "sql",
      `select timestamp, event_message, metadata from ${source} order by timestamp desc limit 1000`,
    );
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` },
    });
    if (!response.ok) {
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (!payload || payload.error || !Array.isArray(payload.result)) {
      continue;
    }
    scannedSources.push(source);
    scannedRows += payload.result.length;
    const serialized = JSON.stringify(payload.result);
    if (
      serialized.includes(sentinel) ||
      serialized.includes(editorCapability) ||
      serialized.includes(viewerCapability) ||
      serialized.includes(wrongCapability)
    ) {
      throw new Error(`Raw capability/sentinel leaked into ${source}.`);
    }
  }
  if (!scannedSources.length) {
    throw new Error("No hosted log source was available for leakage review.");
  }
  return { scannedSources, scannedRows };
};

const startedAt = new Date(Date.now() - 30_000);
const setupSql = `
insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values (${sqlLiteral(ownerId)}, 'authenticated', 'authenticated',
  ${sqlLiteral(`vault-asset-${ownerId}@example.invalid`)}, '', now(), now());
insert into public.vaults
  (id, owner_id, state, protocol_version, active_room_id, snapshot_generation)
values (${sqlLiteral(vaultId)}, ${sqlLiteral(ownerId)}, 'active', 1,
  ${sqlLiteral(`room_${randomBytes(12).toString("base64url")}`)}, 0);
insert into public.vault_invitations
  (id, vault_id, role, capability_hash, authorization_version, created_by, expires_at)
values
  (${sqlLiteral(editorInvitationId)}, ${sqlLiteral(vaultId)}, 'editor',
   public.vault_capability_hash(${sqlLiteral(vaultId)}, ${sqlLiteral(
  editorCapability,
)}), 1, ${sqlLiteral(ownerId)}, now() + interval '15 minutes'),
  (${sqlLiteral(viewerInvitationId)}, ${sqlLiteral(vaultId)}, 'viewer',
   public.vault_capability_hash(${sqlLiteral(vaultId)}, ${sqlLiteral(
  viewerCapability,
)}), 1, ${sqlLiteral(ownerId)}, now() + interval '15 minutes');
`;

try {
  runSql(setupSql);

  const validBytes = canonicalEnvelope();
  await createAndUpload(fileIds.valid, validBytes);
  const completed = await callFunction({
    action: "complete-upload",
    vaultId,
    invitationCapability: editorCapability,
    fileId: fileIds.valid,
  });
  if (completed.state !== "ready") {
    throw new Error("Asset was not completed.");
  }

  let reachableDownloadUrl;
  let downloadExpiresAt;
  for (const capability of [viewerCapability, editorCapability]) {
    const download = await callFunction({
      action: "create-download",
      vaultId,
      invitationCapability: capability,
      fileId: fileIds.valid,
    });
    const ttl = download.expiresAt - Date.now();
    if (
      download.encryptedDigest !== digest(validBytes) ||
      download.ciphertextBytes !== validBytes.byteLength ||
      !Number.isFinite(download.expiresAt) ||
      ttl < 50_000 ||
      ttl > 65_000
    ) {
      throw new Error("Signed download metadata/TTL did not match the asset.");
    }
    const signedUrl = new URL(download.url);
    if (signedUrl.protocol !== "https:") {
      throw new Error("Hosted signed download URL did not use HTTPS.");
    }
    const response = await fetch(signedUrl);
    if (!response.ok) {
      throw new Error(`Signed download failed with status ${response.status}.`);
    }
    const downloadedBytes = new Uint8Array(await response.arrayBuffer());
    if (!Buffer.from(downloadedBytes).equals(Buffer.from(validBytes))) {
      throw new Error("Signed download bytes differed from the envelope.");
    }
    if (capability === viewerCapability) {
      reachableDownloadUrl = signedUrl;
      downloadExpiresAt = download.expiresAt;
    }
  }

  await expectCode(
    {
      action: "create-upload",
      vaultId,
      invitationCapability: viewerCapability,
      fileId: `asset_${randomBytes(12).toString("base64url")}`,
      encryptedDigest: digest(validBytes),
      ciphertextBytes: validBytes.byteLength,
    },
    403,
    "VAULT_CAPABILITY_FORBIDDEN",
  );
  await expectCode(
    {
      action: "create-download",
      vaultId,
      invitationCapability: wrongCapability,
      fileId: fileIds.valid,
    },
    400,
    "VAULT_CAPABILITY_INVALID",
  );

  const tamperedBytes = new TextEncoder().encode(
    `${new TextDecoder().decode(canonicalEnvelope())} `,
  );
  await createAndUpload(fileIds.tampered, tamperedBytes);
  await expectCode(
    {
      action: "complete-upload",
      vaultId,
      invitationCapability: editorCapability,
      fileId: fileIds.tampered,
    },
    400,
    "VAULT_ENVELOPE_INVALID",
  );

  const expectedBytes = canonicalEnvelope();
  const differentBytes = canonicalEnvelope();
  await createAndUpload(
    fileIds.digestMismatch,
    differentBytes,
    digest(expectedBytes),
  );
  await expectCode(
    {
      action: "complete-upload",
      vaultId,
      invitationCapability: editorCapability,
      fileId: fileIds.digestMismatch,
    },
    409,
    "VAULT_ASSET_CONFLICT",
  );

  const largeBytes = canonicalEnvelope(
    randomUUID(),
    "A".repeat(512 * 1024),
  );
  await createAndUpload(fileIds.large, largeBytes);
  const largeCompleted = await callFunction({
    action: "complete-upload",
    vaultId,
    invitationCapability: editorCapability,
    fileId: fileIds.large,
  });
  if (largeCompleted.state !== "ready") {
    throw new Error("Hosted large encrypted asset was not completed.");
  }
  const largeDownload = await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: viewerCapability,
    fileId: fileIds.large,
  });
  const largeResponse = await fetch(largeDownload.url);
  const largeDownloadedBytes = new Uint8Array(
    await largeResponse.arrayBuffer(),
  );
  if (
    !largeResponse.ok ||
    largeDownload.encryptedDigest !== digest(largeBytes) ||
    largeDownload.ciphertextBytes !== largeBytes.byteLength ||
    !Buffer.from(largeDownloadedBytes).equals(Buffer.from(largeBytes))
  ) {
    throw new Error("Hosted large encrypted asset roundtrip did not match.");
  }

  const residualDownload = await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: viewerCapability,
    fileId: fileIds.valid,
  });
  reachableDownloadUrl = new URL(residualDownload.url);
  downloadExpiresAt = residualDownload.expiresAt;

  runSql(
    `update public.vault_invitations set revoked_at = now(), authorization_version = authorization_version + 1 where id = ${sqlLiteral(
      viewerInvitationId,
    )};`,
  );
  await expectCode(
    {
      action: "create-download",
      vaultId,
      invitationCapability: viewerCapability,
      fileId: fileIds.valid,
    },
    403,
    "VAULT_CAPABILITY_REVOKED",
  );
  await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: editorCapability,
    fileId: fileIds.valid,
  });
  if (!(await fetch(reachableDownloadUrl)).ok) {
    throw new Error("Already-issued signed URL did not survive revocation.");
  }

  const residualWait = Math.max(0, downloadExpiresAt - Date.now() + 5_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, residualWait));
  if ((await fetch(reachableDownloadUrl)).ok) {
    throw new Error("Signed URL remained valid after its 60-second window.");
  }

  // Hosted log ingestion is asynchronous. Give the management API a short
  // bounded window after the signed-URL assertion before scanning it.
  await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  const logReview = await scanRemoteLogs(startedAt);

  console.log("PASS hosted signed upload is path-scoped and refuses overwrite");
  console.log(
    "PASS completion rejects malformed and digest-mismatched envelopes",
  );
  console.log(
    "PASS viewer/editor download and viewer write boundary are enforced",
  );
  console.log("PASS hosted large encrypted asset upload/download roundtrip");
  console.log("PASS wrong and revoked capabilities return stable errors");
  console.log("PASS issued URL expires after the 60-second residual window");
  console.log(
    `PASS hosted logs scanned without raw capability/sentinel (${logReview.scannedSources.join(
      ", ",
    )}; ${logReview.scannedRows} rows)`,
  );
} finally {
  if (storagePaths.length) {
    await serviceClient.storage.from("vault-assets").remove(storagePaths);
  }
  try {
    runSql(`
      delete from public.vaults where id = ${sqlLiteral(vaultId)};
      delete from auth.users where id = ${sqlLiteral(ownerId)};
    `);
  } catch {
    // Preserve the primary gate failure while cleanup remains best-effort.
  }
}
