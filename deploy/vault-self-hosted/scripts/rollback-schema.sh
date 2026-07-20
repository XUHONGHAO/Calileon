#!/bin/sh
set -eu

if [ "${ALLOW_VAULT_SCHEMA_ROLLBACK:-NO}" != "YES" ]; then
  echo "Vault schema rollback refused: set ALLOW_VAULT_SCHEMA_ROLLBACK=YES" >&2
  exit 2
fi

psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_rollback.sql
