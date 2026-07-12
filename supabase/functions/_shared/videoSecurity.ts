/* eslint-disable */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^\[[0-9a-f:]+\]$/i;

const isPrivateIPv4 = (hostname: string) => {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
    return true;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
};

export const parseAllowedVideoHosts = (raw: string | undefined) =>
  (raw || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

const hostMatches = (hostname: string, allowedHost: string) =>
  allowedHost.startsWith("*.")
    ? hostname.endsWith(allowedHost.slice(1)) &&
      hostname !== allowedHost.slice(2)
    : hostname === allowedHost;

export const validateVideoSourceURL = (
  rawUrl: string,
  allowedHosts: readonly string[],
) => {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    IPV6_RE.test(url.host) ||
    (IPV4_RE.test(hostname) && isPrivateIPv4(hostname)) ||
    !allowedHosts.some((allowedHost) => hostMatches(hostname, allowedHost))
  ) {
    throw new Error("video-source-not-allowed");
  }

  return url;
};

export const fetchVideoWithValidatedRedirects = async (input: {
  sourceUrl: string;
  allowedHosts: readonly string[];
  signal: AbortSignal;
  maxRedirects?: number;
}) => {
  let url = validateVideoSourceURL(input.sourceUrl, input.allowedHosts);
  const maxRedirects = input.maxRedirects ?? 3;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: input.signal,
      headers: { Accept: "video/mp4,video/webm" },
    });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location || redirectCount === maxRedirects) {
      throw new Error("video-source-redirect-rejected");
    }
    url = validateVideoSourceURL(
      new URL(location, url).toString(),
      input.allowedHosts,
    );
  }

  throw new Error("video-source-redirect-rejected");
};

export const readVideoBodyWithLimit = async (
  response: Response,
  maxBytes: number,
) => {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error("video-too-large");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("video-body-missing");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("video-too-large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
};

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

export const verifyCollabAssetToken = async (input: {
  token: string;
  secret: string;
  sceneId: string;
}) => {
  const [encodedHeader, encodedPayload, encodedSignature] =
    input.token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return false;
  }

  try {
    const header = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedHeader)),
    );
    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    );
    if (
      header.alg !== "HS256" ||
      payload.sceneId !== input.sceneId ||
      typeof payload.exp !== "number" ||
      payload.exp * 1000 <= Date.now()
    ) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(input.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    return false;
  }
};
