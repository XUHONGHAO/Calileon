# P4a Vault production self-hosting

This directory is the F4 deployment baseline for a fully self-hosted Vault. Vault remains disabled by default and must never fall back to a plain scene, legacy persistence, or an ordinary collaboration room.

## Supported version combination

The compatibility gate is exact:

| Component               | Required version                 |
| ----------------------- | -------------------------------- |
| App deployment contract | `p4a-f4-v1`                      |
| Vault protocol          | `1`                              |
| Vault schema            | `1`                              |
| room-server contract    | `1`                              |
| PostgreSQL baseline     | Supabase PostgreSQL `17.6.1.143` |
| Edge Runtime baseline   | `v1.74.2`                        |
| GoTrue baseline         | `v2.192.0`                       |
| PostgREST baseline      | `v14.14`                         |
| Storage API baseline    | `v1.62.5`                        |

The complete pinned image list is in `versions.env`. Other Supabase versions may work, but they are not part of the F4 evidence until the full migration, schema, function, Storage, backup, and restore smoke is rerun.

App and room build images are pinned by digest and accept registry-qualified build args. `versions.env` uses the Docker Library public ECR mirror so a deployment is not coupled to Docker Hub token availability; operators may use another trusted mirror only when it resolves to the same recorded digest.

## Architecture

```text
Browser
  -> HTTPS/WSS Caddy
       -> static App container
       -> room-server container (/socket.io and /vault/*)
  -> HTTPS self-hosted Supabase
       -> Auth/PostgREST/Storage/Edge Runtime/PostgreSQL
```

The App and room server use one public origin. Supabase uses a separate HTTPS origin. Caddy access logs are disabled because bearer fragments must never be logged; URL fragments are not sent over HTTP in any case. room-server Vault logs contain only the frozen sanitized metadata allowlist.

The Vault production App disables PWA generation so an older Service Worker cannot keep an App bundle that is incompatible with the active room/schema version combination.

`VITE_APP_SELF_HOSTED=true` also keeps the runtime asset path local and omits automatic font-CDN preconnects, Excalidraw+ redirect logic, and Simple Analytics injection from the generated HTML.

## Supabase requirement

Production uses the official Supabase self-hosted Docker distribution. The Supabase CLI development stack and an isolated hosted Supabase project remain supported for testing, but neither is described as the fully self-hosted production service.

Pin the official self-hosted images to `versions.env`, then add these repository files to its Edge Runtime functions volume:

- `supabase/functions/vault-control-plane/`
- `supabase/functions/vault-asset-access/`
- `supabase/functions/_shared/`

Configure the Edge Runtime with:

- `APP_ALLOWED_ORIGINS=<APP_ORIGIN>`;
- `VAULT_ROOM_CONTROL_PLANE_URL=<APP_ORIGIN>/vault/control-plane/disconnect`;
- `VAULT_ROOM_CONTROL_PLANE_TOKEN=<same random token as room-server>`.

Do not expose service-role keys to the App or room-server. Only the Edge Runtime receives the service-role key through the official Supabase environment.

## First deployment

1. Copy `.env.example` to the ignored `.env` file and replace every placeholder.
2. Keep `VAULT_ENABLED=false` while installing Supabase, Edge Functions, schema, TLS, and origin rules.
3. Validate configuration:

   ```powershell
   ./scripts/validate-config.ps1 -EnvFile ./.env
   ```

4. Install the independent Vault schema and run smoke tests:

   ```powershell
   docker compose --env-file versions.env --env-file .env -f compose.yml --profile ops run --rm migrate
   docker compose --env-file versions.env --env-file .env -f compose.yml --profile ops run --rm schema-smoke
   ```

5. Deploy the two Edge Functions and verify that the persistence capability endpoint reports `deploymentVersion=p4a-f4-v1` and `schemaVersion=1`.
6. Set `VAULT_ENABLED=true`, rebuild, and start App/room/Caddy:

   ```powershell
   docker compose --env-file versions.env --env-file .env -f compose.yml build --pull
   docker compose --env-file versions.env --env-file .env -f compose.yml up -d
   ./scripts/deployment-smoke.ps1 -AppOrigin https://vault.example.com -HttpOrigin http://vault.example.com -PersistenceCapabilitiesUrl https://supabase.example.com/functions/v1/vault-control-plane
   ```

Caddy obtains and renews public certificates through ACME. Port 80 must remain available for redirect/challenge traffic unless DNS challenge configuration is added by the operator.

## Local production-like TLS smoke

Use `APP_ORIGIN=https://vault.localhost:8443`, `SUPABASE_PUBLIC_URL=http://127.0.0.1:54321`, and `VAULT_SUPABASE_URL=http://host.docker.internal:54321`. Set `VAULT_ALLOW_DOCKER_HOST_HTTP=true` only for this local smoke. Run Compose with both files:

```powershell
docker compose --env-file versions.env --env-file .env -f compose.yml -f compose.local.yml up -d --build
./scripts/deployment-smoke.ps1 -AppOrigin https://vault.localhost:8443 -HttpOrigin http://vault.localhost:8080 -PersistenceCapabilitiesUrl http://127.0.0.1:54321/functions/v1/vault-control-plane -AllowUntrustedCertificate
```

`Caddyfile.local` uses an internal CA only for local evidence. It is not the production certificate configuration.

The local override binds room port `3002` to `127.0.0.1` only. This is required because the Supabase CLI Edge Runtime is on a separate Docker network and its `VAULT_ROOM_CONTROL_PLANE_URL=http://host.docker.internal:3002/vault/control-plane/disconnect` must reach the trusted invitation-revoke/expiry disconnect endpoint. The port must not be bound to `0.0.0.0` or exposed to the LAN. Production Supabase uses the public HTTPS App origin described above instead of this loopback exception.

When the existing ignored App and room development env files are already configured, generate the ignored Compose env without printing credentials:

```powershell
./scripts/prepare-local-env.ps1
```

If the machine cannot reach the container registry for Node/nginx base images, the host-build smoke still verifies the exact production App configuration, HTTPS/WSS proxy, security headers, and room contract using the already installed Caddy image and the running local room-server:

```powershell
./scripts/build-local-app.ps1
docker compose --env-file .env.local -f compose.host-smoke.yml up -d
./scripts/deployment-smoke.ps1 -AppOrigin https://vault.localhost:8443 -HttpOrigin http://vault.localhost:8080 -PersistenceCapabilitiesUrl http://127.0.0.1:54321/functions/v1/vault-control-plane -AllowUntrustedCertificate
```

This is local evidence only; it does not replace the fresh-environment multi-stage container build required before F4 is finally marked complete.

## Upgrade and rollback

Before upgrading, create a DB + Storage backup and record the current images. Run `upgrade-smoke.ps1`; it applies migrations twice to prove idempotency and runs schema smoke. App/room/schema version drift is rejected before Vault opens.

Rollback order:

1. set `VAULT_ENABLED=false` and rebuild the App;
2. keep ciphertext DB/Storage intact;
3. restore the previously pinned App and room images;
4. restore the matching DB/Storage backup when schema rollback is required;
5. only on an approved disposable/backup-restored target, set `ALLOW_VAULT_SCHEMA_ROLLBACK=YES` and run the `rollback-schema` profile.

Never implement rollback by writing Vault data into plain or legacy tables.

## Backup and restore

`backup.ps1` creates a full PostgreSQL custom-format dump, a Storage archive, SHA-256 checksums, and a version manifest. The dump deliberately preserves Supabase object ownership and ACLs: dropping either would change RLS/RPC behavior and could make `SECURITY DEFINER` functions owned by the restore superuser. Backups contain encrypted Vault objects but still contain account metadata and must be access-controlled.

```powershell
./scripts/backup.ps1 -EnvFile ./.env -StorageDockerVolume supabase_storage
```

Restore only into an approved empty target with the exact pinned Supabase version combination. A full dump includes Supabase platform objects and event triggers, so the restore role must own or be able to replace those objects. The official self-hosted image uses `supabase_admin`; connecting as its non-superuser `postgres` role fails closed instead of partially bypassing ownership checks.

```powershell
./scripts/restore.ps1 -BackupDirectory ./backups/vault-... -EnvFile ./.env -DatabaseRestoreRole supabase_admin -StorageDockerVolume restored_supabase_storage -ConfirmDestructiveRestore
```

For an isolated hosted/remote Supabase recovery project, pass the recovery role provided for that target. The script substitutes only the URL username and reuses the password already present in the ignored env file; it never prints the connection string. If that role cannot replace Supabase platform objects, the restore stops and the target must be recreated before retrying.

The database preflight also refuses any target that already contains Vault tables. Restore is deliberately non-idempotent: recreate the isolated recovery database after a failed or completed attempt rather than running destructive cleanup over an in-use Vault deployment.

The target must be initialized by the complete pinned Supabase distribution, not by starting the PostgreSQL image alone. In particular, Auth, Storage, Realtime, Functions, API, and authenticator roles must already exist. The restore preflight rejects a target with missing platform roles instead of silently changing owners or inventing weaker replacement roles.

Restore rejects manifests older than `supabase-full-v1`, including earlier F4 test dumps that omitted ownership or privileges. A data-only success is not a valid Vault recovery if grants, RLS, function owners, or Storage policies drift.

Immediately before `pg_restore`, the script disables event triggers already present in the empty target. This prevents automatic Data API grants from mutating restored function ACLs while objects are recreated. The dump then recreates the source event triggers and their enabled state. Any failure after this point invalidates the disposable target; recreate it before retrying.

The restore script reapplies the frozen Vault schema and migrations, then runs the DB and Storage schema smoke before extracting Storage. This reconciles explicit Vault grants/RLS/policies after any target-side automatic Data API defaults. After restore, start the services and open a known Vault with the correct client-held key. A successful server restore alone is insufficient; the acceptance evidence must show that the correct key decrypts and an incorrect key still fails closed.

## Deletion and retention

Vault deletion is a 7-day soft delete. It immediately revokes active access but does not promise immediate disappearance from historical backups. After the grace period, operators delete due encrypted Storage objects through the Storage API, purge the corresponding Vault aggregate, and retain backup copies according to the documented backup policy. F5 must record the actual retention interval.

## Limits and monitoring

- room message size: `VAULT_MAX_PAYLOAD_BYTES`;
- messages per admitted socket/minute: `VAULT_MAX_MESSAGES_PER_MINUTE`;
- active sockets per Vault: `VAULT_MAX_CONNECTIONS_PER_VAULT`;
- snapshot ciphertext: 50 MiB schema limit;
- asset ciphertext: 100 MiB schema and Storage bucket limit;
- liveness: `/healthz`;
- configuration readiness: `/readyz`;
- protocol readiness: `/vault/capabilities` and the persistence capability endpoint.

Alert on readiness failures, repeated `VAULT_RATE_LIMITED`, container restarts, PostgreSQL/Storage capacity, backup failure, certificate renewal failure, and schema version mismatch. Do not export payloads, capabilities, Authorization headers, query bodies, decrypted scenes, filenames, MIME types, or URL fragments.

## External network access

Expected automatic egress is limited to:

- Caddy ACME certificate issuance/renewal;
- App browser requests to the configured self-hosted Supabase origin;
- room-server capability resolution to the configured Supabase origin;
- Edge Runtime disconnect notices to the configured room control-plane URL;
- container image pulls and operator-configured backup destinations.

Sentry is disabled in the production App image. AI, external iframe, and remote media remain governed by the Vault egress guard and are not silently enabled by this deployment template.

## HTTP fail-closed boundary

Non-local HTTP App URLs fail the client secure-context gate. Production room-server rejects wildcard origins and rejects non-HTTPS origins. Therefore an ordinary HTTP LAN deployment cannot advertise a ready Vault even if an operator sets `VAULT_ENABLED=true` accidentally.
