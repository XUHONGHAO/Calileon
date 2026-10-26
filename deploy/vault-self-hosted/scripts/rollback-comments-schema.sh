#!/bin/sh
set -eu

# Drops the scene comment tables (ADR 0037) and with them every comment.
# Turning the feature off never needs this: set SCENE_COMMENTS_ENABLED=false
# and rebuild the App instead.
if [ "${ALLOW_COMMENTS_SCHEMA_ROLLBACK:-NO}" != "YES" ]; then
  echo "Comments schema rollback refused: set ALLOW_COMMENTS_SCHEMA_ROLLBACK=YES" >&2
  exit 2
fi

psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /schema/schema_comments_rollback.sql
