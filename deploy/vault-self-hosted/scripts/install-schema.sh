#!/bin/sh
set -eu

# ---------------------------------------------------------------------------
# Ordinary (non-Vault) cloud backend: cloud scenes, assets, shares, embeds, the
# activity log, Cast, collab rooms/persistence, AI tasks and AI video assets.
#
# These used to be missing from this script, which only installed the Vault
# files. The App is built with those features on, so every one of them failed at
# runtime -- starting a collaboration session surfaced it as "couldn't save to
# the backend database" -- while `schema-smoke` still passed, because the Vault
# smokes cannot see the plain schema at all.
#
# The order follows each file's own "Run after ..." header. The last three
# entries form a chain over the `excalidraw-assets` Storage bucket and must stay
# in this order: `schema_assets.sql` upserts the bucket with the 20 MiB default,
# `schema_video_assets.sql` then overrides its size limit and MIME allow-list
# (100 MiB, adding video), and `schema_e2e_cloud.sql` appends
# `application/octet-stream` to whatever allow-list it finds.
#
# Every file is idempotent, so this is safe to re-run against an existing
# database, including one that was just populated by a restore.
# ---------------------------------------------------------------------------
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
