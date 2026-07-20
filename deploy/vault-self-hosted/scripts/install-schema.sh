#!/bin/sh
set -eu

psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_prerequisites.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_storage.sql

for migration in /migrations/*.sql; do
  if [ -f "$migration" ]; then
    psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  fi
done
