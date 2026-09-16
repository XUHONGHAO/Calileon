const baseURL = process.argv[2] || "http://127.0.0.1:8787";
const origin = new URL(baseURL).origin;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const health = await fetch(`${baseURL}/ai-proxy/healthz`);
assert(health.status === 200, "Caddy did not route the proxy health check.");
assert((await health.json()).status === "ok", "Proxy health is not ok.");

const fallback = await fetch(`${baseURL}/not-a-route`);
assert(fallback.status === 200, "Caddy fallback route is not reachable.");
assert((await fallback.text()) === "smoke app", "Caddy route order changed.");

const preflight = await fetch(`${baseURL}/ai-proxy/v1/forward`, {
  method: "OPTIONS",
  headers: {
    Origin: origin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers":
      "authorization, content-type, x-excalidraw-ai-target, x-excalidraw-ai-proxy-token",
  },
});
assert(preflight.status === 204, "Proxy CORS preflight did not pass.");
assert(
  preflight.headers.get("access-control-allow-origin") === origin,
  "Proxy CORS origin was not preserved.",
);

const sse = await fetch(`${baseURL}/__smoke__/sse`);
assert(sse.ok && sse.body, "Caddy SSE endpoint did not return a body.");
const reader = sse.body.getReader();
const startedAt = Date.now();
const first = await reader.read();
const firstText = new TextDecoder().decode(first.value);
assert(!first.done && firstText.includes("first"), "SSE first chunk missing.");
assert(Date.now() - startedAt < 1000, "SSE response was buffered by the edge.");
const remaining = [];
for (;;) {
  const next = await reader.read();
  if (next.done) {
    break;
  }
  remaining.push(Buffer.from(next.value));
}
assert(
  Buffer.concat([Buffer.from(first.value), ...remaining])
    .toString("utf8")
    .includes("second"),
  "SSE terminal chunk missing.",
);

const binary = await fetch(`${baseURL}/__smoke__/binary`);
assert(binary.ok, "Binary media endpoint did not return 200.");
assert(
  Buffer.from(await binary.arrayBuffer()).equals(
    Buffer.from([0, 1, 2, 255, 254, 3, 4, 0]),
  ),
  "Binary media bytes were changed by the edge.",
);

const disabledGateway = await fetch(`${baseURL}/ai-gateway/v1/healthz`, {
  headers: { Origin: origin },
});
assert(
  disabledGateway.status === 404 &&
    disabledGateway.headers.get("x-excalidraw-ai-gateway-error") ===
      "AI_GATEWAY_DISABLED",
  "Managed gateway disabled contract changed.",
);

process.stdout.write("AI proxy Caddy smoke passed.\n");
