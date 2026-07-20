import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const quietExec = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...options,
  });

const quietShell = (command) =>
  quietExec(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]);

const status = JSON.parse(quietShell("supabase status --output json"));
const apiUrl = status.API_URL;
const anonKey = status.ANON_KEY;
const serviceRoleKey = status.SERVICE_ROLE_KEY;
if (!apiUrl || !anonKey || !serviceRoleKey) {
  throw new Error(
    "Local Supabase status is missing required in-memory values.",
  );
}

const vaultId = randomUUID();
const ownerId = randomUUID();
const editorInvitationId = randomUUID();
const viewerInvitationId = randomUUID();
const editorCapability = randomBytes(32).toString("base64url");
const viewerCapability = randomBytes(32).toString("base64url");
const wrongCapability = randomBytes(32).toString("base64url");
const fileIds = {
  valid: `asset_${randomBytes(12).toString("base64url")}`,
  large: `asset_${randomBytes(12).toString("base64url")}`,
  tampered: `asset_${randomBytes(12).toString("base64url")}`,
  digestMismatch: `asset_${randomBytes(12).toString("base64url")}`,
};

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const runSql = (sql) => {
  quietExec(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_excalidraw-self-hosted",
      "psql",
      "-X",
      "--set=ON_ERROR_STOP=1",
      "--username=postgres",
      "--dbname=postgres",
      "--quiet",
    ],
    { input: sql },
  );
};

const functionUrl = `${apiUrl}/functions/v1/vault-asset-access`;
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
const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("base64url");
const localReachableSignedUrl = (value) => {
  const signed = new URL(value);
  if (signed.hostname === "kong") {
    const publicApi = new URL(apiUrl);
    signed.protocol = publicApi.protocol;
    signed.host = publicApi.host;
  }
  return signed.toString();
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
  if (error) throw new Error(`Signed upload failed: ${error.message}`);
  const second = await anonClient.storage
    .from("vault-assets")
    .uploadToSignedUrl(expectedPath, registration.token, bytes, {
      contentType: "application/json",
    });
  if (!second.error) {
    throw new Error(
      "Signed upload unexpectedly allowed overwrite (upsert:false gate). ",
    );
  }
};

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
)}),
   1, ${sqlLiteral(ownerId)}, now() + interval '15 minutes'),
  (${sqlLiteral(viewerInvitationId)}, ${sqlLiteral(vaultId)}, 'viewer',
   public.vault_capability_hash(${sqlLiteral(vaultId)}, ${sqlLiteral(
  viewerCapability,
)}),
   1, ${sqlLiteral(ownerId)}, now() + interval '15 minutes');
`;

try {
  runSql(setupSql);

  const probeBytes = canonicalEnvelope();
  const probe = await serviceClient.rpc("register_vault_asset", {
    p_vault_id: vaultId,
    p_capability: editorCapability,
    p_file_id: fileIds.valid,
    p_encrypted_digest: digest(probeBytes),
    p_ciphertext_bytes: probeBytes.byteLength,
  });
  if (probe.error) {
    throw new Error(
      `Direct RPC probe failed (${probe.error.code ?? "unknown"}).`,
    );
  }
  const signedProbe = await serviceClient.storage
    .from("vault-assets")
    .createSignedUploadUrl(`vault/${vaultId}/${fileIds.valid}`, {
      upsert: false,
    });
  if (signedProbe.error) {
    throw new Error(
      `Direct signed-upload probe failed (${
        signedProbe.error.status ?? "unknown"
      }).`,
    );
  }

  const validBytes = probeBytes;
  await createAndUpload(fileIds.valid, validBytes);
  const completed = await callFunction({
    action: "complete-upload",
    vaultId,
    invitationCapability: editorCapability,
    fileId: fileIds.valid,
  });
  if (completed.state !== "ready") throw new Error("Asset was not completed.");

  const download = await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: viewerCapability,
    fileId: fileIds.valid,
  });
  if (
    download.encryptedDigest !== digest(validBytes) ||
    download.ciphertextBytes !== validBytes.byteLength ||
    !Number.isFinite(download.expiresAt) ||
    download.expiresAt - Date.now() < 50_000 ||
    download.expiresAt - Date.now() > 65_000
  ) {
    throw new Error(
      "Signed download metadata/TTL did not match the stored envelope.",
    );
  }
  const reachableDownloadUrl = localReachableSignedUrl(download.url);
  const downloadedBytes = new Uint8Array(
    await (await fetch(reachableDownloadUrl)).arrayBuffer(),
  );
  if (!Buffer.from(downloadedBytes).equals(Buffer.from(validBytes))) {
    throw new Error(
      "Signed download bytes differed from the canonical envelope.",
    );
  }

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
    throw new Error("Large encrypted asset was not completed.");
  }
  const largeDownload = await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: viewerCapability,
    fileId: fileIds.large,
  });
  const largeDownloadedBytes = new Uint8Array(
    await (
      await fetch(localReachableSignedUrl(largeDownload.url))
    ).arrayBuffer(),
  );
  if (
    largeDownload.encryptedDigest !== digest(largeBytes) ||
    largeDownload.ciphertextBytes !== largeBytes.byteLength ||
    !Buffer.from(largeDownloadedBytes).equals(Buffer.from(largeBytes))
  ) {
    throw new Error("Large encrypted asset roundtrip did not match.");
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

  const residualDownload = await callFunction({
    action: "create-download",
    vaultId,
    invitationCapability: viewerCapability,
    fileId: fileIds.valid,
  });
  const residualDownloadUrl = localReachableSignedUrl(residualDownload.url);

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
  if (!(await fetch(residualDownloadUrl)).ok) {
    throw new Error(
      "Already-issued signed URL did not survive the documented residual window.",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  if ((await fetch(residualDownloadUrl)).ok) {
    throw new Error(
      "Signed URL remained valid after the 60-second residual window.",
    );
  }

  for (const container of [
    "supabase_edge_runtime_excalidraw-self-hosted",
    "supabase_rest_excalidraw-self-hosted",
    "supabase_kong_excalidraw-self-hosted",
    "supabase_storage_excalidraw-self-hosted",
    "supabase_db_excalidraw-self-hosted",
  ]) {
    const logs = quietShell(`docker logs --since 3m ${container} 2>&1`);
    if (
      logs.includes(editorCapability) ||
      logs.includes(viewerCapability) ||
      logs.includes(wrongCapability) ||
      /vault[-_ ]sentinel/i.test(logs)
    ) {
      throw new Error(`Raw capability/sentinel leaked into ${container} logs.`);
    }
  }

  console.log("PASS signed upload uses an isolated path and refuses overwrite");
  console.log(
    "PASS completion verifies canonical envelope, digest, and byte count",
  );
  console.log("PASS viewer can download but cannot upload");
  console.log("PASS large encrypted asset upload/download roundtrip");
  console.log("PASS wrong capability and tampered ciphertext are rejected");
  console.log(
    "PASS issued URL expires after the documented 60-second residual window",
  );
  console.log("PASS container logs contain no raw test capability or sentinel");
} finally {
  if (storagePaths.length) {
    await serviceClient.storage.from("vault-assets").remove(storagePaths);
  }
  try {
    runSql(`delete from auth.users where id = ${sqlLiteral(ownerId)};`);
  } catch {
    // Preserve the primary acceptance failure while making cleanup best-effort.
  }
}
