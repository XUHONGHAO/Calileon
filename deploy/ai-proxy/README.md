# Excalidraw AI Proxy

This directory contains the optional app-only AI forwarding service adopted by ADR 0027. Browser direct remains the default. The proxy exists for providers that cannot be called from a browser because of CORS and does not replace the existing provider adapters.

The service is deliberately thin:

- it forwards the provider method, headers, body, status, and response stream;
- it validates every target and redirect against the SSRF policy, pins DNS to the actual connection address, and rejects HTTPS downgrades;
- it never stores provider keys, proxy tokens, prompts, request bodies, responses, images, or videos;
- production requires both an exact Origin allowlist and a rotatable proxy access token;
- it is independent of Supabase, the room server, Vault persistence, and the public `@excalidraw/excalidraw` package.

## Local development

The development server does not automatically load a local `.env` file. Set the variables in the shell that launches the App and proxy:

```powershell
$env:AI_PROXY_ALLOWED_ORIGINS = "http://localhost:3000"
$env:AI_PROXY_REQUIRE_CLIENT_TOKEN = "false"
$env:AI_PROXY_ALLOW_HTTP_LOCALHOST = "true"
$env:VITE_APP_AI_PROXY_URL = "http://localhost:3016/ai-proxy/v1/forward"
yarn start:with-ai-proxy
```

In AI Settings → Network, select Backend proxy and leave the endpoint empty to use `VITE_APP_AI_PROXY_URL`. Local development may omit the proxy token only when `AI_PROXY_REQUIRE_CLIENT_TOKEN=false`.

Development and production use the same forwarding, streaming, redirect, and SSRF implementation. Vite does not proxy provider requests.

## Production configuration

1. Copy `.env.example` to the ignored `.env` file in this directory.
2. Replace the example App origin and token. Origins must be exact `http://` or `https://` origins without paths or wildcards. Production App origins should use HTTPS.
3. Generate at least 32 random bytes for the token, keep it outside Git, and distribute it only to authorized browser users. The token raises the abuse barrier but is not a full user-authentication system.
4. Validate and start the service from the repository root:

   ```powershell
   docker compose --env-file deploy/ai-proxy/.env -f deploy/ai-proxy/compose.yml config
   docker compose --env-file deploy/ai-proxy/.env -f deploy/ai-proxy/compose.yml build --pull
   docker compose --env-file deploy/ai-proxy/.env -f deploy/ai-proxy/compose.yml up -d
   ```

The Compose service is not published on a host port. It exposes port `3016` only on `AI_PROXY_EDGE_NETWORK`; the App-facing Caddy/nginx service must join that network.

The image is multi-stage, runs as the non-root `node` user, has a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, and uses only a small `/tmp` tmpfs. The Node 20 base image is pinned by digest in `.env.example` and the Dockerfile.

## Caddy routing

Merge `Caddyfile.example` into the existing App site. The `/ai-proxy/*` matcher must appear before the static App fallback:

```caddy
@ai_proxy path /ai-proxy/*
handle @ai_proxy {
  reverse_proxy ai-proxy:3016 {
    flush_interval -1
  }
}
```

`flush_interval -1` preserves SSE and large response streaming. Caddy forwards the browser `Origin` header by default. Do not enable request-header dumps, and either disable access logs for this route/site or use a reviewed format that never records sensitive headers. The App CSP must allow `connect-src 'self'`; a custom cross-origin proxy must also be explicitly allowed by the App deployment.

For the normal same-origin deployment, the browser endpoint can stay empty: the client uses `/ai-proxy/v1/forward`. A custom proxy endpoint must be HTTPS outside localhost development, and its `AI_PROXY_ALLOWED_ORIGINS` must include the App origin.

## Health, readiness, and rotation

- `GET /ai-proxy/healthz` is an unauthenticated liveness check and does not inspect provider connectivity.
- `GET /ai-proxy/readyz` validates that the running service accepted its configuration. It is protected by the same Origin and token policy as forwarding and does not send a prompt to a provider.

After routing is active, test readiness without placing the token in source files:

```powershell
$headers = @{
  Origin = "https://draw.example.com"
  "X-Excalidraw-AI-Proxy-Token" = $env:AI_PROXY_TOKEN
}
Invoke-WebRequest -Headers $headers https://draw.example.com/ai-proxy/readyz
```

To rotate the access token, set `AI_PROXY_CLIENT_TOKENS=current,previous`, restart the proxy, move browsers to `current`, then remove `previous` and restart again. Never use a provider API key as the proxy token.

## Limits and troubleshooting

The defaults are a 10-second connect timeout, 10-minute request timeout, 2-minute idle timeout, 64 MiB request-body limit, and five redirects. Response bodies are streamed and are not capped by the Node service; protect server bandwidth and concurrency at the deployment layer when needed.

Proxy mode adds a network hop, concentrates traffic on one server IP, and consumes server bandwidth. Video is the highest-cost path. Prefer browser direct whenever the provider supports CORS.

If `/healthz` works but `/readyz` fails, check the exact Origin and proxy token. If forwarding returns a target-blocked error, inspect the provider URL and DNS result; do not weaken the private/reserved-address policy. Provider non-2xx responses are passed through without a proxy error marker and should be debugged as provider failures.

Adding this service or Caddy route does not enable AI in Vault or the P1 single-file runtime. Their existing AI-deny boundaries remain authoritative.
