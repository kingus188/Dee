#!/bin/sh
set -eu
# The entrypoint runs this only when initializing a new PostgreSQL data volume.
# psql variables quote the generated password as data, not executable SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE assistant_app LOGIN PASSWORD :'app_password';
GRANT CONNECT, CREATE ON DATABASE assistant TO assistant_app;
SQL
