#!/bin/sh
set -eu

VAULT_DEPLOYMENT_SCOPE="${VAULT_DEPLOYMENT_SCOPE:-vault-only}"

case "$VAULT_DEPLOYMENT_SCOPE" in
  vault-only | full) ;;
  *)
    echo "VAULT_DEPLOYMENT_SCOPE must be 'vault-only' or 'full', got '$VAULT_DEPLOYMENT_SCOPE'" >&2
    exit 1
    ;;
esac

if [ "$VAULT_DEPLOYMENT_SCOPE" = "full" ]; then
  # Presence check for the ordinary cloud backend. Read-only: it only reports
  # which tables, Storage buckets and RPCs are missing. The Vault smokes below
  # cannot see any of those objects, which is why a missing plain schema went
  # unnoticed once. `-At` gives unaligned rows whose first field is the verdict,
  # because the file returns a table instead of raising.
  self_host=$(psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -At \
    -f /schema/schema_self_host_smoke.sql)
  echo "$self_host"
  if echo "$self_host" | grep -q '^FAIL'; then
    echo "FATAL: the ordinary cloud backend schema is incomplete (see rows above)" >&2
    exit 1
  fi
fi

psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_smoke.sql

# The retention job is what keeps `vault_snapshot_updates` bounded; a missing job
# would silently restore the unbounded growth it exists to prevent, so its
# absence fails the smoke rather than passing unnoticed.
retention_jobs=$(psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -At \
  -c "select count(*) from cron.job where jobname = 'vault-snapshot-updates-retention'")
if [ "$retention_jobs" != "1" ]; then
  echo "FATAL: the vault snapshot-update retention job is not scheduled" >&2
  exit 1
fi
echo "retention job: scheduled"

# schema_vault_storage_smoke.sql asserts that the database has no client
# `storage.objects` policy at all, which only holds for an isolated Vault
# deployment: the ordinary cloud backend needs those policies so browsers can
# upload assets to `excalidraw-assets`. In the full scope the equivalent
# property is checked instead -- the Vault bucket stays fail-closed, RLS stays
# enabled, no client policy is bucket-agnostic, and none reaches the Vault
# bucket. See scripts/vault-storage-smoke-full-scope.sql.
if [ "$VAULT_DEPLOYMENT_SCOPE" = "full" ]; then
  psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f /ops/vault-storage-smoke-full-scope.sql
else
  psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f /schema/schema_vault_storage_smoke.sql
fi
