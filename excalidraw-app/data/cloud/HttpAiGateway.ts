import { validateAIProxyEndpoint } from "../../ai/proxyConfig";

import { BackendError } from "./errors";

import type { AiGateway, AuthProvider } from "./types";

const getBaseURL = (configured?: string) => {
  const raw = String(
    configured || import.meta.env.VITE_APP_AI_GATEWAY_URL || "/ai-gateway/v1",
  ).trim();
  return validateAIProxyEndpoint(raw, { allowQuery: false }).replace(
    /\/+$/,
    "",
  );
};

export class AiGatewayHttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly requestId?: string,
    message = code,
  ) {
    super(message);
    this.name = "AiGatewayHttpError";
  }
}

const MAX_GATEWAY_ERROR_BYTES = 64 * 1024;

const normalizeGatewayLimit = (value: number | undefined) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 100)
    : 50;

const readLimitedResponseText = async (response: Response) => {
  const stream = response.clone().body;
  if (!stream) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const remaining = MAX_GATEWAY_ERROR_BYTES - bytes;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      const chunk =
        result.value.byteLength > remaining
          ? result.value.subarray(0, remaining)
          : result.value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (chunk.byteLength < result.value.byteLength) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(payload);
};

const readGatewayError = async (response: Response) => {
  let body: any = null;
  try {
    body = JSON.parse(await readLimitedResponseText(response));
  } catch {
    // Stable response headers remain authoritative when the body is unreadable.
  }
  return new AiGatewayHttpError(
    body?.error?.code ||
      response.headers.get("X-Excalidraw-AI-Gateway-Error") ||
      "AI_GATEWAY_INTERNAL_ERROR",
    response.status,
    body?.error?.requestId ||
      response.headers.get("X-Excalidraw-AI-Request-ID") ||
      undefined,
    body?.error?.message || undefined,
  );
};

export const createHttpAiGateway = ({
  auth,
  enabled = true,
  fetchImpl = fetch,
  baseURL,
}: {
  auth: Pick<AuthProvider, "getAccessToken">;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  baseURL?: string;
}): AiGateway => {
  const gatewayBaseURL = getBaseURL(baseURL);
  const assertEnabled = () => {
    if (!enabled) {
      throw new BackendError("not-configured", "AI Gateway is disabled.", {
        recoverable: false,
      });
    }
  };
  const request = async (
    path: string,
    init: RequestInit = {},
    accessToken?: string,
    options: { allowProviderError?: boolean } = {},
  ) => {
    assertEnabled();
    const token = accessToken || (await auth.getAccessToken());
    if (!token) {
      throw new AiGatewayHttpError("AI_GATEWAY_UNAUTHORIZED", 401);
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchImpl(`${gatewayBaseURL}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
    const gatewayError = response.headers.get("X-Excalidraw-AI-Gateway-Error");
    if (!response.ok && (!options.allowProviderError || gatewayError)) {
      throw await readGatewayError(response);
    }
    return response;
  };
  const json = async <T>(
    path: string,
    init: RequestInit = {},
    accessToken?: string,
  ) => (await request(path, init, accessToken)).json() as Promise<T>;

  return {
    isEnabled: () => enabled,
    getCatalog: (options) => json("/catalog", {}, options?.accessToken),
    invoke: async (input) => {
      const headers = new Headers(input.headers);
      headers.delete("Authorization");
      headers.delete("X-Goog-Api-Key");
      headers.delete("Api-Key");
      headers.delete("X-Api-Key");
      headers.delete("ApiKey");
      headers.delete("X-Excalidraw-AI-Target");
      if (input.auditDraftId) {
        headers.set("X-Excalidraw-AI-Audit-Draft", input.auditDraftId);
      }
      const query = new URLSearchParams(input.query || {});
      const suffix = query.size ? `?${query.toString()}` : "";
      return request(
        `/invoke/${encodeURIComponent(input.routeId)}/${encodeURIComponent(
          input.operation,
        )}${suffix}`,
        {
          method: input.method || (input.body == null ? "GET" : "POST"),
          body: input.body,
          headers,
          signal: input.signal,
        },
        input.accessToken,
        { allowProviderError: true },
      );
    },
    getQuota: (options) => json("/quota", {}, options?.accessToken),
    getUsage: (options) =>
      json(
        `/usage?limit=${normalizeGatewayLimit(options?.limit)}`,
        {},
        options?.accessToken,
      ),
    getAuditConsent: (options) =>
      json("/audit/consent", {}, options?.accessToken),
    setAuditConsent: async (value, options) => {
      await request(
        "/audit/consent",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: value }),
        },
        options?.accessToken,
      );
    },
    createAuditDraft: async (input) => {
      const result = await json<{ auditId: string }>(
        "/audit/drafts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routeId: input.routeId,
            prompt: input.prompt,
          }),
        },
        input.accessToken,
      );
      return result.auditId;
    },
    listAudits: (options) =>
      json(
        `/audits?limit=${normalizeGatewayLimit(options?.limit)}`,
        {},
        options?.accessToken,
      ),
    getAudit: (id, options) =>
      json(`/audits/${encodeURIComponent(id)}`, {}, options?.accessToken),
    deleteAudit: async (id, options) => {
      await request(
        `/audits/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        options?.accessToken,
      );
    },
    deleteAccountData: async (options) => {
      await request("/account", { method: "DELETE" }, options?.accessToken);
    },
    createDeviceAuthorization: async () => {
      assertEnabled();
      const response = await fetchImpl(`${gatewayBaseURL}/device/code`, {
        method: "POST",
        credentials: "omit",
      });
      if (!response.ok) {
        throw await readGatewayError(response);
      }
      return response.json();
    },
    exchangeDeviceAuthorization: async (deviceCode) => {
      assertEnabled();
      const response = await fetchImpl(`${gatewayBaseURL}/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
        credentials: "omit",
      });
      if (!response.ok) {
        throw await readGatewayError(response);
      }
      return response.json();
    },
    approveDeviceAuthorization: async (userCode) => {
      await request("/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
    },
  };
};
