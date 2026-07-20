# P4a Vault Supabase environment workflows

These PowerShell entry points install and test the same fail-closed Vault SQL in two supported environments:

- local Supabase CLI + Docker;
- a disposable, isolated hosted Supabase project.

They never enable the Vault product entry point, install a room server, or add a plain/legacy persistence fallback. Real credentials belong only in ignored `*.local.env` files or process environment variables.

## Prerequisites

On Windows, start with the check-only helper. Its default action does not install packages, enable Windows features, modify `PATH`, pull images, restart Docker, or reboot Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/windows-prerequisites.ps1
```

It reports WSL2, Docker Desktop/Linux-engine, Supabase CLI, Deno, `psql`, administrator status, standard pending-reboot markers, and the Microsoft/winget/npm TLS endpoints needed by the selected installers. Docker-backed `psql` intentionally relies on `docker pull` as the authoritative Docker Registry check so Docker Desktop can use its own proxy configuration. Use `-Strict` when a non-zero exit code is required for an incomplete local gate. `-NoNetworkProbe` is available only for offline check-only diagnostics.

Install actions require both `-Action Install` and `-AcceptInstall`. Run them from an Administrator PowerShell window after saving work and manually rebooting if the check reports `PendingReboot`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/windows-prerequisites.ps1 `
  -Action Install -Components WSL2,DockerDesktop,Deno -AcceptInstall

# Run after any requested reboot and after Docker Desktop's first-run UI is complete.
powershell -ExecutionPolicy Bypass -File scripts/vault/windows-prerequisites.ps1 `
  -Action Install -Components SupabaseCLI,Psql -AcceptInstall
```

The installer is deliberately phased and idempotent. It never reboots Windows, starts Docker Desktop, bypasses TLS validation, supplies installer passwords, or reads/writes Vault credentials. `-WhatIf` previews install targets without changing state.

The pinned Supabase baseline is `2.109.1` and can be changed explicitly with `-SupabaseVersion`. The helper installs it as an exact user-local npm package under `%LOCALAPPDATA%\ExcalidrawVaultTools`; it never uses unsupported `npm install -g supabase`. A new terminal inherits the user `PATH` entry.

The `psql` option installs a user-local shim backed by the official `postgres:17-alpine` Docker image. The major-version tag is maintained upstream and is not an immutable digest; deployments that require byte-for-byte tool pinning should pass an independently verified `postgres:<tag>` using the explicit `-PostgresImage` parameter. Before invoking `psql`, the workflow parses the validated database URL into the libpq fields `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`, and `PGCONNECT_TIMEOUT`. The shim forwards those fields to Docker by variable name only, so neither the URL nor its password enters the `psql` or `docker` argument list. SQL files named by the workflow are mounted read-only into the short-lived client container and their host paths are replaced with container paths. All pre-existing process values are restored even when `psql` fails. Hosted remote URLs require the exact pair `sslmode=verify-full&sslrootcert=system`, which verifies the hostname and uses the operating-system trust store; local loopback URLs use `sslmode=disable` and clear `PGSSLROOTCERT`. For the local Supabase database the shim maps IPv4, IPv6, and `localhost` loopback hosts to `host.docker.internal` inside the container.

After the helper is ready, these commands must be available on `PATH`:

- Docker Desktop with the Linux container engine running;
- Supabase CLI;
- PostgreSQL `psql` client.

Standalone Deno is optional for editor tooling. The local Supabase Edge runtime runs in Docker. Check tools without changing state:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/local.ps1 -Action preflight
```

System installation still has two manual boundaries: Windows may require a reboot after WSL2 changes, and Docker Desktop requires its normal UAC/first-run flow. Re-run the check after each boundary; do not continue to Vault schema or asset smoke while either item is only `Warning` or `Blocked`.

## Local self-hosted path

The default local database URL is the standard Supabase CLI endpoint at `127.0.0.1:54322`. Override it only with another loopback URL; the script rejects non-local hosts.

Run the complete disposable local workflow:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/local.ps1 -Action all
```

`all` performs, in order:

1. `supabase start --exclude analytics,vector`;
2. `supabase db reset --local`;
3. atomically installs the minimal Vault-only pgcrypto/trigger prerequisite;
4. installs `schema_vault.sql` and the private `vault-assets` bucket without creating a plain `scenes` table;
5. runs the Vault schema and Storage smoke scripts.

The reset is destructive only to the local Supabase database. Individual actions are also available: `start`, `status`, `reset`, `schema`, `smoke`, and `stop`.

For F3 browser discovery and immediate invitation-revoke fan-out, copy `local-function.example.env` to the ignored `local-function.local.env`, use the same random control-plane token when starting `excalidraw-room`, and serve the Vault Edge Functions with:

```powershell
supabase functions serve vault-control-plane vault-asset-access `
  --env-file scripts/vault/local-function.local.env
```

The local Edge runtime reaches the host room server only through `host.docker.internal`; the browser never receives the control-plane token.

With the local Edge Functions and room server running, verify that the signed-in owner revoke path reaches the trusted room control plane and immediately disconnects the matching viewer socket:

```powershell
node scripts/vault/local-control-plane-gate.mjs
```

The gate expects the local Supabase URL, anon key, and service-role key only in process environment variables. It creates one random auth/Vault fixture and removes it in `finally`; no key or capability is printed.

The local workflow deliberately excludes Supabase Analytics and Vector on Docker Desktop for Windows. Vector otherwise requires exposing the Docker daemon over unauthenticated TCP port 2375. Local leakage review uses direct `docker logs` inspection for the individual Vault-facing containers; hosted remote acceptance still reviews the provider's Edge/PostgREST/APM logs.

To use a non-default local port, copy `local.example.env` to `local.local.env`, edit it, and add `-EnvFile scripts/vault/local.local.env`.

### Concurrent snapshot CAS and revoke lock gate

After the local schema smoke succeeds, run the real multi-session database gate without resetting or restarting the shared local stack:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/local-cas-gate.ps1
```

The gate creates two isolated Vault fixtures with random UUIDs and launches independent `psql` sessions. It proves that two writers using the same expected generation cannot both commit: the first transaction holds the Vault aggregate lock, the second is observed in PostgreSQL with `wait_event_type = 'Lock'`, and after the first commit the second must return the stable `VAULT_SNAPSHOT_CONFLICT` error. A second pair proves that invitation revoke blocks behind an in-flight CAS invitation lock, advances the authorization version after the CAS commits, and causes the next write to fail with `VAULT_CAPABILITY_REVOKED`.

Test capabilities are fixed synthetic values used only inside generated temporary SQL. The script never prints them, removes the temporary directory, terminates only its run-specific database sessions, and deletes its Vault and auth fixtures in `finally`. Set `VAULT_LOCAL_DATABASE_URL` or pass the same ignored local env file used by `local.ps1` when the database is on a non-default loopback port.

## Isolated hosted Supabase path

Do not use this path against a production or shared project. Create a dedicated test project first, then copy `remote.example.env` to `remote.local.env` and fill in its placeholders. The script requires the project ref twice plus the exact `DISPOSABLE_TEST_PROJECT` confirmation. It accepts only the exact direct project host or a hosted pooler using the exact `postgres.<project-ref>` username, rejects query parameters that can override the target, requires the `postgres` database, and accepts only the exact TLS query contract `sslmode=verify-full&sslrootcert=system` (parameter order is not significant). These checks are intentional anti-footgun gates, not proof that a project is non-production.

Validate inputs locally without contacting Supabase:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/remote.ps1 `
  -Action preflight `
  -EnvFile scripts/vault/remote.local.env
```

Run the full isolated deployment and smoke:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vault/remote.ps1 `
  -Action all `
  -EnvFile scripts/vault/remote.local.env
```

After schema smoke succeeds, run the same real multi-session CAS/revoke-lock gate against the confirmed disposable hosted project:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/vault/remote-cas-gate.ps1 `
  -EnvFile scripts/vault/remote.local.env
```

The remote gate reuses the local concurrency assertions but refuses loopback, requires the exact disposable-project confirmation, and requires `sslmode=verify-full` plus the downloaded Supabase CA certificate. It never resets, stops, links, or migrates the project. Every run uses fresh random UUIDs and run-specific PostgreSQL application names, terminates only those sessions, and removes its Vault/auth fixtures in `finally`.

The remote workflow performs, in order:

1. installs only the Vault prerequisite/Vault/Storage SQL in one ordered `psql` transaction with `ON_ERROR_STOP=1`;
2. runs transaction-rollback schema smoke and the strict isolated-project Storage smoke;
3. deploys `vault-asset-access` and `vault-control-plane` with gateway JWT verification disabled. The asset function authenticates with invitation capability; the control-plane function keeps GET discovery public but validates the signed-in user itself before owner mutations.

For a complete hosted F3 gate, set `VAULT_APP_ALLOWED_ORIGINS`, `VAULT_ROOM_CONTROL_PLANE_URL`, and `VAULT_ROOM_CONTROL_PLANE_TOKEN` together in the ignored remote env file. The room URL must be public HTTPS and use the same token as `excalidraw-room`. If these values are omitted, the deployed discovery document reports Vault disabled and the client remains fail-closed.

The workflow never creates persistent `supabase link` state and never pushes unrelated repository migrations. Every Supabase CLI mutation carries the confirmed `--project-ref`. The database URL cannot be supplied as a script parameter: it is read only from the process environment or the ignored env file, validated, then split into libpq environment fields for `psql` rather than passed as a URL argument. The function receives Supabase-managed `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the workflow sets only the non-secret bucket name.

Run the isolated hosted Storage/Edge gate after schema and function deployment:

```powershell
node scripts/vault/remote-asset-gate.mjs scripts/vault/remote.local.env
```

The gate obtains the hosted `anon` and `service_role` keys through the authenticated Supabase CLI into process memory, then exercises signed upload, completion, download, viewer/editor boundaries, tamper/digest/revoke behavior, the 60-second residual URL window, and hosted log-source leakage review. It removes its random fixture and Storage objects in `finally`; it never prints or persists keys, passwords, or capabilities.

## What these scripts do not prove

A successful SQL smoke is necessary but does not complete the F2 real-environment gate. `local-cas-gate.ps1` and `remote-cas-gate.ps1` complete the local and isolated-hosted two-session CAS/revoke-lock assertions; acceptance still requires:

- a real signed upload/complete/download cycle and the 60-second residual URL window check;
- Edge/PostgREST/proxy/APM log review for raw capability leakage;
- room-server admission, viewer rejection, revoke/expire fan-out, and existing socket disconnect tests;
- two-browser editor/editor and viewer/editor verification.

The isolated-project Storage smoke requires RLS on `storage.objects` and rejects every client policy granted to `public`, `anon`, or `authenticated`; this avoids trying to infer whether a broad pre-existing policy happens to exclude `vault-assets`. The dedicated bucket does not use a MIME allowlist: access is path-scoped by signed URLs, and completion verifies the encrypted envelope, digest, and byte count before marking an object ready.

## Deletion and retention gate

Run the repeatable VR-019 online lifecycle gate against local Docker Supabase:

```powershell
.\scripts\vault\retention-gate.ps1 -Target local
```

Run the same gate against the explicitly confirmed disposable hosted project:

```powershell
.\scripts\vault\retention-gate.ps1 `
  -Target remote `
  -EnvFile .\scripts\vault\remote.local.env
```

The gate creates only random encrypted test fixtures. It verifies that owner revoke plus soft delete immediately returns `VAULT_NOT_ACTIVE` for capability resolution and snapshot CAS, preserves the encrypted snapshot, asset row, and real Storage object during the fixed seven-day grace period, then simulates the due time and performs the operator-ordered purge: Storage object first, Vault aggregate second. The aggregate delete must cascade through invitations, snapshots, and asset rows. All fixture identifiers and credentials remain in memory, and best-effort cleanup runs in `finally`.

Hosted Storage may continue serving an already cached or already signed object URL for its previously accepted residual window. The purge assertion therefore requires that the object disappear from the Storage listing and `storage.objects`, while the separate asset gate continues to verify the bounded 60-second signed-URL residual window.

This gate covers the online database and Storage lifecycle only. Soft deletion does not promise immediate disappearance from historical backups; backup expiry remains the deployment operator's documented retention policy.
