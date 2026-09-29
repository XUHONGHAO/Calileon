#!/bin/sh
set -eu

# ---------------------------------------------------------------------------
# Deployment scope. `vault-only` (the default) reproduces the frozen F4
# deployment shape: only the Vault schema exists, which is what the isolated
# Vault acceptance checks assert. `full` additionally installs the ordinary
# cloud backend, which the App is compiled to use -- without it cloud scenes,
# assets, shares, embeds, the activity log, Cast, collab rooms/persistence and
# AI tasks all fail at runtime.
#
# The two shapes are mutually exclusive at the database level: the ordinary
# backend needs client `storage.objects` policies so browsers can upload assets,
# and `schema_vault_storage_smoke.sql` requires that no such policy exists. That
# assertion belongs to an isolated Vault project; `full` checks the property
# that actually protects the Vault instead (see schema-smoke.sh).
# ---------------------------------------------------------------------------
VAULT_DEPLOYMENT_SCOPE="${VAULT_DEPLOYMENT_SCOPE:-vault-only}"

case "$VAULT_DEPLOYMENT_SCOPE" in
  vault-only | full) ;;
  *)
    echo "VAULT_DEPLOYMENT_SCOPE must be 'vault-only' or 'full', got '$VAULT_DEPLOYMENT_SCOPE'" >&2
    exit 1
    ;;
esac

if [ "$VAULT_DEPLOYMENT_SCOPE" = "full" ]; then
  # -------------------------------------------------------------------------
  # Ordinary (non-Vault) cloud backend: cloud scenes, assets, shares, embeds,
  # the activity log, Cast, collab rooms/persistence, AI tasks and AI video
  # assets.
  #
  # The order follows each file's own "Run after ..." header. The last three
  # entries form a chain over the `excalidraw-assets` Storage bucket and must
  # stay in this order: `schema_assets.sql` upserts the bucket with the 20 MiB
  # default, `schema_video_assets.sql` then overrides its size limit and MIME
  # allow-list (100 MiB, adding video), and `schema_e2e_cloud.sql` appends
  # `application/octet-stream` to whatever allow-list it finds.
  #
  # Every file is idempotent, so this is safe to re-run against an existing
  # database, including one that was just populated by a restore.
  # -------------------------------------------------------------------------
  for schema in \
    schema.sql \
    schema_assets.sql \
    schema_shares.sql \
    schema_activity_log.sql \
    schema_collab_rooms.sql \
    schema_collab_persistence.sql \
    schema_embeds.sql \
    schema_ai_tasks.sql \
    schema_cast_sessions.sql \
    schema_video_assets.sql \
    schema_e2e_cloud.sql
  do
    psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f "/schema/$schema"
  done
fi

# ---------------------------------------------------------------------------
# Vault Online schema. Independent of the files above: no table, function or
# Storage bucket is shared (`vaults`/`vault_*` and the separate `vault-assets`
# bucket), so the two halves can be installed in either order.
# ---------------------------------------------------------------------------
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_prerequisites.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_storage.sql

for migration in /migrations/*.sql; do
  if [ -f "$migration" ]; then
    psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  fi
done

# Retention for the Vault idempotency ledger, which would otherwise grow without
# bound (one full encrypted envelope per autosave). Adds nothing to the `public`
# schema -- it schedules a daily pg_cron job. See the file's own header for why
# deleting old ledger rows cannot lose data.
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /ops/vault-snapshot-retention.sql
