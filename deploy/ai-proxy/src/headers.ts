import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";

const REQUEST_HEADER_DENYLIST = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "forwarded",
  "via",
  "cookie",
  "origin",
  "referer",
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
]);

const isInternalHeader = (name: string) => {
  return name.startsWith("x-excalidraw-ai-");
};

const isForwardedHeader = (name: string) => {
  return name.startsWith("x-forwarded-");
};

const getConnectionHeaderNames = (headers: IncomingHttpHeaders) => {
  const connection = headers.connection;
  const values = Array.isArray(connection)
    ? connection
    : connection
    ? [connection]
    : [];

  return new Set(
    values
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
};

const isCrossOriginSensitiveHeader = (name: string) => {
  return (
    name === "authorization" ||
    name === "api-key" ||
    name === "apikey" ||
    name.startsWith("x-") ||
    name.includes("token") ||
    name.includes("secret") ||
    name.includes("credential") ||
    name.includes("signature")
  );
};

const normalizeHeaderValue = (
  value: string | readonly string[] | undefined,
): string | string[] | undefined => {
  if (Array.isArray(value)) {
    return [...value];
  }

  return value as string | undefined;
};

export const buildUpstreamRequestHeaders = (
  headers: IncomingHttpHeaders,
  target: URL,
  includeBodyHeaders: boolean,
  includeProviderCredentials: boolean,
) => {
  const forwarded: Record<string, string | string[]> = {};
  const connectionHeaderNames = getConnectionHeaderNames(headers);

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();

    if (
      rawValue == null ||
      REQUEST_HEADER_DENYLIST.has(name) ||
      connectionHeaderNames.has(name) ||
      isForwardedHeader(name) ||
      isInternalHeader(name) ||
      (!includeBodyHeaders &&
        (name === "content-length" || name === "content-type")) ||
      (!includeProviderCredentials && isCrossOriginSensitiveHeader(name))
    ) {
      continue;
    }

    const value = normalizeHeaderValue(rawValue);

    if (value != null) {
      forwarded[name] = value;
    }
  }

  forwarded.host = target.host;
  forwarded["user-agent"] = "Excalidraw-AI-Proxy/1";

  return forwarded;
};

export const copyUpstreamResponseHeaders = (
  upstream: IncomingMessage,
  response: ServerResponse,
) => {
  const connectionHeaderNames = getConnectionHeaderNames(upstream.headers);

  for (const [rawName, rawValue] of Object.entries(upstream.headers)) {
    const name = rawName.toLowerCase();

    if (
      rawValue == null ||
      RESPONSE_HEADER_DENYLIST.has(name) ||
      connectionHeaderNames.has(name) ||
      isInternalHeader(name) ||
      name.startsWith("access-control-")
    ) {
      continue;
    }

    response.setHeader(name, rawValue);
  }
};

const appendVary = (response: ServerResponse, values: readonly string[]) => {
  const current = response.getHeader("Vary");
  const entries = new Set(
    (Array.isArray(current) ? current.join(",") : String(current || ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  values.forEach((value) => entries.add(value));
  response.setHeader("Vary", Array.from(entries).join(", "));
};

export const applyCORSResponseHeaders = (
  response: ServerResponse,
  origin: string | null,
) => {
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }

  response.setHeader(
    "Access-Control-Expose-Headers",
    [
      "X-Excalidraw-AI-Proxy",
      "X-Excalidraw-AI-Request-ID",
      "X-Excalidraw-AI-Proxy-Error",
    ].join(", "),
  );
  appendVary(response, ["Origin"]);
};

export const applyPreflightHeaders = (
  response: ServerResponse,
  origin: string,
  method: string,
  requestedHeaders: readonly string[],
) => {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", method);
  response.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders.join(", "),
  );
  response.setHeader("Access-Control-Max-Age", "600");
  appendVary(response, [
    "Origin",
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
  ]);
};

export const isAllowedPreflightHeader = (rawName: string) => {
  const name = rawName.trim().toLowerCase();

  return (
    /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) &&
    !REQUEST_HEADER_DENYLIST.has(name) &&
    !isForwardedHeader(name)
  );
};
