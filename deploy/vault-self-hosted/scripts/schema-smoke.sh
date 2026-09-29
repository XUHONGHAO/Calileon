#!/bin/sh
set -eu

# Ordinary cloud backend presence check. Read-only: it only reports which
# tables, Storage buckets and RPCs are missing. The Vault smokes below cannot
# see any of those objects, which is why a missing plain schema went unnoticed.
#
# The file returns a table rather than raising, so its result has to be
# inspected here; `-At` gives unaligned rows whose first field is the overall
# verdict.
self_host=$(psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -At \
  -f /schema/schema_self_host_smoke.sql)
echo "$self_host"
if echo "$self_host" | grep -q '^FAIL'; then
  echo "FATAL: the ordinary cloud backend schema is incomplete (see rows above)" >&2
  exit 1
fi

psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_smoke.sql
psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_vault_storage_smoke.sql
