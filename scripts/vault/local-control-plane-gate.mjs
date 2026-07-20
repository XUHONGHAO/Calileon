import { createHash, randomBytes, randomUUID } from "node:crypto";

import { io } from "socket.io-client";

const apiUrl = process.env.VAULT_LOCAL_SUPABASE_URL;
const anonKey = process.env.VAULT_LOCAL_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.VAULT_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const roomUrl = process.env.VAULT_LOCAL_ROOM_URL || "http://localhost:3002";

if (!apiUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Vault local control-plane gate environment is incomplete.");
}

const jsonRequest = async (url, init, expectedStatuses = [200]) => {
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!expectedStatuses.includes(response.status)) {
    const code =
      body && typeof body === "object"
        ? body.error || body.message || body.code
        : null;
    throw new Error(typeof code === "string" ? code : "VAULT_INTERNAL");
  }
  return body;
};

const rpc = (accessToken, name, body, expectedStatuses = [200]) =>
  jsonRequest(
    `${apiUrl}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    expectedStatuses,
  );

const capabilityHash = (vaultId, capability) =>
  createHash("sha256")
    .update(
      `excalidraw-vault-capability\0${1}\0${vaultId.toLowerCase()}\0${capability}`,
      "utf8",
    )
    .digest("base64url");

const waitForSocketEvent = (socket, event, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}.`)),
      timeoutMs,
    );
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

const emitWithAck = (socket, event, payload, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for ${event} acknowledgement.`)),
      timeoutMs,
    );
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });

const email = `vault-control-${randomUUID()}@example.test`;
const password = `${randomBytes(24).toString("base64url")}!aA1`;
let userId = null;
let socket = null;

try {
  const createdUser = await jsonRequest(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  userId = createdUser?.id;
  if (typeof userId !== "string") {
    throw new Error("VAULT_INTERNAL");
  }

  const session = await jsonRequest(
    `${apiUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  const ownerAccessToken = session?.access_token;
  if (typeof ownerAccessToken !== "string") {
    throw new Error("VAULT_CAPABILITY_FORBIDDEN");
  }

  const vaultId = randomUUID();
  const editorCapability = randomBytes(32).toString("base64url");
  const viewerCapability = randomBytes(32).toString("base64url");
  const created = await rpc(ownerAccessToken, "create_vault", {
    p_vault_id: vaultId,
    p_protocol_version: 1,
    p_editor_capability_hash: capabilityHash(vaultId, editorCapability),
    p_editor_expires_at: null,
  });

  const provisioned = await jsonRequest(
    `${roomUrl}/vault/rooms`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 1,
        vaultId,
        invitationId: created.invitationId,
      }),
    },
    [201],
  );
  const activeRoomId = provisioned?.activeRoomId;
  if (created?.vaultId !== vaultId || typeof activeRoomId !== "string") {
    throw new Error("VAULT_INTERNAL");
  }
  await rpc(ownerAccessToken, "activate_vault", {
    p_vault_id: vaultId,
    p_active_room_id: activeRoomId,
  });

  const viewer = await rpc(ownerAccessToken, "create_vault_invitation", {
    p_vault_id: vaultId,
    p_role: "viewer",
    p_capability_hash: capabilityHash(vaultId, viewerCapability),
    p_expires_at: null,
  });
  if (viewer?.role !== "viewer") {
    throw new Error("VAULT_INTERNAL");
  }

  socket = io(roomUrl, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await waitForSocketEvent(socket, "connect");
  const admission = await emitWithAck(socket, "vault:join", {
    protocolVersion: 1,
    vaultId,
    invitationCapability: viewerCapability,
    senderSessionId: randomUUID(),
  });
  if (!admission?.ok || admission.resolution?.role !== "viewer") {
    throw new Error("VAULT_CAPABILITY_FORBIDDEN");
  }

  const revokedEvent = waitForSocketEvent(socket, "vault:capability-revoked");
  const disconnected = waitForSocketEvent(socket, "disconnect");
  const revocation = await jsonRequest(
    `${apiUrl}/functions/v1/vault-control-plane`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${ownerAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "revoke-invitation",
        vaultId,
        invitationId: viewer.invitationId,
      }),
    },
  );
  const [notice] = await revokedEvent;
  await disconnected;
  if (
    revocation?.reason !== "revoked" ||
    revocation.authorizationVersion !== 2 ||
    notice?.vaultId !== vaultId ||
    notice?.invitationId !== viewer.invitationId ||
    notice?.authorizationVersion !== 2 ||
    notice?.reason !== "revoked"
  ) {
    throw new Error("VAULT_INTERNAL");
  }

  let rejectedCode = null;
  try {
    await rpc(anonKey, "resolve_vault_capability", {
      p_vault_id: vaultId,
      p_capability: viewerCapability,
    });
  } catch (error) {
    rejectedCode = error instanceof Error ? error.message : null;
  }
  if (rejectedCode !== "VAULT_CAPABILITY_REVOKED") {
    throw new Error("VAULT_INTERNAL");
  }

  process.stdout.write(
    "Vault local Edge control-plane revoke and socket disconnect gate passed.\n",
  );
} finally {
  socket?.disconnect();
  if (userId) {
    await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }).catch(() => undefined);
  }
}
