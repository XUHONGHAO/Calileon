# AI Gateway Production Operations

This document is the operator runbook for the managed gateway and the thin BYOK proxy. It assumes the App-facing reverse proxy joins the `AI_PROXY_EDGE_NETWORK` network and routes `/ai-proxy/*` and `/ai-gateway/*` before the static App fallback.

## Preflight

Run the checked-in gate from the repository root before a production rollout:

```powershell
yarn ai-proxy:preflight
```

The gate checks production mode, strong proxy and metrics tokens, HTTPS origins, AWS KMS, TLS-protected Postgres, reachable route catalog configuration, and placeholder values. It never prints environment values.

## Rollout

1. Validate the reviewed route catalog and run `yarn ai-proxy:preflight`.
2. Run the one-shot migration with the same immutable image used by the gateway.
3. Start the Compose stack and wait for `/ai-gateway/readyz` to return `200`.
4. Run the load baseline against the edge URL:

   ```powershell
   yarn ai-proxy:load-test --url https://draw.example.com/ai-proxy/healthz --requests 200 --concurrency 20 --max-p95-ms 500
   ```

5. Run a canary managed request with a real user token and a low-cost route. Do not use provider keys in shell history.

For the real external identity, database, KMS, route, and provider deployment, run the authenticated acceptance checks with secrets supplied only by the process environment:

```powershell
$env:AI_GATEWAY_ACCEPTANCE_URL = "https://draw.example.com"
$env:AI_GATEWAY_ACCEPTANCE_ORIGIN = "https://draw.example.com"
$env:AI_GATEWAY_ACCEPTANCE_JWT = $realSupabaseAccessToken
$env:AI_GATEWAY_ACCEPTANCE_ROUTE = "text-route"
$env:AI_GATEWAY_ACCEPTANCE_METRICS_TOKEN = $metricsToken
yarn ai-proxy:production-acceptance
Remove-Item Env:AI_GATEWAY_ACCEPTANCE_JWT,Env:AI_GATEWAY_ACCEPTANCE_METRICS_TOKEN
```

This verifies the live readiness dependency chain, JWT/JWKS authentication, catalog, quota store, and (when supplied) authenticated metrics. A real low-cost provider invocation must still be performed as a separate canary because request bodies differ by route protocol.

## Failure drills

The drills are intentionally explicit and reversible:

```powershell
powershell -File deploy/ai-proxy/ops/failure-drill.ps1 -Scenario gateway-restart -Endpoint https://draw.example.com
powershell -File deploy/ai-proxy/ops/failure-drill.ps1 -Scenario database-unavailable -Endpoint https://draw.example.com
```

The database drill stops only the Compose database service, asserts readiness fails closed, then starts it again and waits for recovery. Run it in a maintenance window because in-flight managed requests may fail.

## Backup and restore

Backups contain encrypted credentials, usage metadata, and audit envelopes. Store them outside Git with restricted access and an independent retention policy:

```powershell
powershell -File deploy/ai-proxy/ops/backup.ps1 -OutputPath D:\secure-backups\ai-gateway-2026-09-16.sql
powershell -File deploy/ai-proxy/ops/restore.ps1 -InputPath D:\secure-backups\ai-gateway-2026-09-16.sql -ConfirmRestore
```

Restore is destructive and requires an explicit switch. Verify the target project, backup checksum, migration version, and operator approval before running it. Perform a restore rehearsal at least once per release cycle.

## Secret and key rotation

- Rotate `AI_PROXY_CLIENT_TOKENS` with `current,previous`, restart, migrate clients, then remove `previous` and restart again.
- Rotate provider credentials through the TTY admin CLI. Never edit the route catalog to hold a secret.
- Rotate the AWS KMS key according to the cloud key policy. Keep old key material available until all encrypted rows are rewrapped and a decrypt smoke passes.
- Rotate the metrics token separately and update the scraper secret without placing it in a URL.

## Monitoring and alerts

Scrape `/ai-gateway/v1/metrics` through an internal authenticated path. Alert on:

- readiness unavailable for more than two consecutive probes;
- `auth_failures_total` or `quota_denied_total` sudden increases;
- upstream failures or failovers above the route baseline;
- active requests near the configured concurrency ceiling;
- response duration and bytes rising beyond the route SLO;
- audit purge failures or database connection errors in container logs.

Metrics, access logs, and error bodies must not contain provider URLs with query secrets, authorization headers, prompts, response bodies, KMS plaintext, or Vault values.

## Security release gate

Run the static security gate and the focused service tests before publishing an image:

```powershell
yarn ai-proxy:security-audit
yarn ai-proxy:test
yarn ai-proxy:build
```

The static gate rejects tracked deployment secrets, private-key material, placeholder production configuration, missing container hardening, unsafe Caddy logging, and accidental credential/header dumps. It is a regression gate, not a substitute for an independent security review or a production penetration test.
