#!/usr/bin/env node

const endpoint = (process.env.AI_GATEWAY_ACCEPTANCE_URL || "").replace(
  /\/$/,
  "",
);
const origin = process.env.AI_GATEWAY_ACCEPTANCE_ORIGIN || "";
const token = process.env.AI_GATEWAY_ACCEPTANCE_JWT || "";
const metricsToken = process.env.AI_GATEWAY_ACCEPTANCE_METRICS_TOKEN || "";
const routeId = process.env.AI_GATEWAY_ACCEPTANCE_ROUTE || "";

if (!endpoint || !origin || !token || !routeId) {
  console.error(
    "AI_GATEWAY_ACCEPTANCE_URL, _ORIGIN, _JWT, and _ROUTE are required",
  );
  process.exit(2);
}

let target;
try {
  target = new URL(endpoint);
} catch {
  console.error("AI_GATEWAY_ACCEPTANCE_URL must be a valid URL");
  process.exit(2);
}
if (
  target.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(target.hostname)
) {
  console.error("production acceptance requires an HTTPS endpoint");
  process.exit(2);
}

const headers = {
  Origin: origin,
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
};

const request = async (path, init = {}) => {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return body;
};

await request("/ai-gateway/readyz", { headers: { Authorization: "" } });
const catalog = JSON.parse(await request("/ai-gateway/v1/catalog"));
if (
  !Array.isArray(catalog.routes) ||
  !catalog.routes.some((route) => route.id === routeId)
) {
  throw new Error("configured acceptance route is missing from the catalog");
}
const quota = JSON.parse(await request("/ai-gateway/v1/quota"));
if (!quota || typeof quota.activeRequests !== "number") {
  throw new Error("quota response is invalid");
}

if (metricsToken) {
  const metrics = await request("/ai-gateway/v1/metrics", {
    headers: {
      Authorization: `Bearer ${metricsToken}`,
      Accept: "text/plain",
    },
  });
  if (!metrics.includes("excalidraw_ai_gateway_active_requests")) {
    throw new Error("metrics response is missing the active request gauge");
  }
}

console.log(
  JSON.stringify({
    ok: true,
    checks: [
      "readyz",
      "catalog",
      "quota",
      ...(metricsToken ? ["metrics"] : []),
    ],
    route: routeId,
  }),
);
