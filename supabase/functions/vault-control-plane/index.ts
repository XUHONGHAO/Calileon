/* eslint-disable */

import {
  errorResponse,
  getCorsHeaders,
  jsonResponse,
} from "../_shared/http.ts";
import {
  createServiceClient,
  createUserClient,
} from "../_shared/supabase.ts";

const PROTOCOL_VERSION = 1 as const;
const DEPLOYMENT_VERSION = "p4a-f4-v1" as const;
const SCHEMA_VERSION = 1 as const;
const CORS_METHODS = "GET, POST, OPTIONS";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ERRORS = new Set([
  "VAULT_CAPABILITY_INVALID",
  "VAULT_CAPABILITY_FORBIDDEN",
  "VAULT_CAPABILITY_EXPIRED",
  "VAULT_CAPABILITY_REVOKED",
  "VAULT_NOT_FOUND",
  "VAULT_NOT_ACTIVE",
  "VAULT_PERSISTENCE_UNAVAILABLE",
  "VAULT_RATE_LIMITED",
  "VAULT_INTERNAL",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const getRoomControlPlane = () => {
  const rawUrl = Deno.env.get("VAULT_ROOM_CONTROL_PLANE_URL") || "";
  const token = Deno.env.get("VAULT_ROOM_CONTROL_PLANE_TOKEN") || "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(
      url.hostname,
    );
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    token.length < 32
  ) {
    return null;
  }
  return { url: url.toString(), token };
};

const getSchemaVersion = async () => {
  try {
    const { data, error } = await createServiceClient().rpc(
      "get_vault_deployment_contract",
    );
    if (
      error ||
      !isRecord(data) ||
      data.deploymentVersion !== DEPLOYMENT_VERSION ||
      data.protocolVersion !== PROTOCOL_VERSION ||
      data.schemaVersion !== SCHEMA_VERSION
    ) {
      return 0;
    }
    return data.schemaVersion;
  } catch {
    return 0;
  }
};

const getCapabilities = async () => {
  const schemaVersion = await getSchemaVersion();
  const enabled =
    getRoomControlPlane() !== null && schemaVersion === SCHEMA_VERSION;
  return {
    deploymentVersion: DEPLOYMENT_VERSION,
    schemaVersion,
    enabled,
    protocolVersions: enabled ? [PROTOCOL_VERSION] : [],
    invitationService: enabled,
    encryptedSnapshotPersistence: enabled,
    encryptedAssetPersistence: enabled,
  };
};

const parseRevokeRequest = (value: unknown) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["action", "vaultId", "invitationId"]) ||
    value.action !== "revoke-invitation" ||
    typeof value.vaultId !== "string" ||
    !UUID_RE.test(value.vaultId) ||
    typeof value.invitationId !== "string" ||
    !UUID_RE.test(value.invitationId)
  ) {
    throw new Error("VAULT_CAPABILITY_INVALID");
  }
  return {
    vaultId: value.vaultId.toLowerCase(),
    invitationId: value.invitationId.toLowerCase(),
  };
};

const parseRevocation = (
  value: unknown,
  vaultId: string,
  invitationId: string,
) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "vaultId",
      "invitationId",
      "authorizationVersion",
      "reason",
    ]) ||
    value.vaultId !== vaultId ||
    value.invitationId !== invitationId ||
    typeof value.authorizationVersion !== "number" ||
    !Number.isSafeInteger(value.authorizationVersion) ||
    value.authorizationVersion < 1 ||
    value.reason !== "revoked"
  ) {
    throw new Error("VAULT_INTERNAL");
  }
  return {
    vaultId,
    invitationId,
    authorizationVersion: value.authorizationVersion,
    reason: "revoked" as const,
  };
};

const toStableError = (error: unknown) => {
  if (error instanceof Error && STABLE_ERRORS.has(error.message)) {
    return error.message;
  }
  if (
    isRecord(error) &&
    error.code === "P0001" &&
    typeof error.message === "string" &&
    STABLE_ERRORS.has(error.message)
  ) {
    return error.message;
  }
  return "VAULT_INTERNAL";
};

const getErrorStatus = (code: string) => {
  if (code === "VAULT_NOT_FOUND") return 404;
  if (code === "VAULT_RATE_LIMITED") return 429;
  if (code === "VAULT_PERSISTENCE_UNAVAILABLE") return 503;
  if (
    code === "VAULT_CAPABILITY_FORBIDDEN" ||
    code === "VAULT_CAPABILITY_EXPIRED" ||
    code === "VAULT_CAPABILITY_REVOKED" ||
    code === "VAULT_NOT_ACTIVE"
  ) {
    return 403;
  }
  if (code === "VAULT_CAPABILITY_INVALID") return 400;
  return 500;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, CORS_METHODS),
    });
  }
  if (request.method === "GET") {
    return jsonResponse(
      request,
      200,
      await getCapabilities(),
      CORS_METHODS,
    );
  }
  if (request.method !== "POST") {
    return errorResponse(
      request,
      405,
      "VAULT_CAPABILITY_INVALID",
      CORS_METHODS,
    );
  }

  try {
    const roomControlPlane = getRoomControlPlane();
    if (!roomControlPlane) {
      throw new Error("VAULT_PERSISTENCE_UNAVAILABLE");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new Error("VAULT_CAPABILITY_INVALID");
    }
    const input = parseRevokeRequest(body);
    const userClient = createUserClient(request);
    const { data: authData, error: authError } =
      await userClient.auth.getUser();
    if (authError || !authData.user) {
      throw new Error("VAULT_CAPABILITY_FORBIDDEN");
    }
    const { data, error } = await userClient.rpc("revoke_vault_invitation", {
      p_vault_id: input.vaultId,
      p_invitation_id: input.invitationId,
    });
    if (error) {
      throw error;
    }
    const revocation = parseRevocation(data, input.vaultId, input.invitationId);
    let response: Response;
    try {
      response = await fetch(roomControlPlane.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${roomControlPlane.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(revocation),
      });
    } catch {
      throw new Error("VAULT_PERSISTENCE_UNAVAILABLE");
    }
    if (response.status !== 204) {
      throw new Error("VAULT_PERSISTENCE_UNAVAILABLE");
    }
    return jsonResponse(request, 200, revocation, CORS_METHODS);
  } catch (error) {
    const code = toStableError(error);
    return errorResponse(request, getErrorStatus(code), code, CORS_METHODS);
  }
});
