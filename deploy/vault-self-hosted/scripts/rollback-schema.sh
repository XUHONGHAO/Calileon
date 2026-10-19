#!/bin/sh
set -eu

if [ "${ALLOW_VAULT_SCHEMA_ROLLBACK:-NO}" != "YES" ]; then
  echo "Vault schema rollback refused: set ALLOW_VAULT_SCHEMA_ROLLBACK=YES" >&2
  exit 2
fi

# v2 first: it refuses while v2 Vaults exist and restores the v1-only
# protocol constraint that schema_vault_rollback.sql expects.
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_v2_rollback.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_rollback.sql
