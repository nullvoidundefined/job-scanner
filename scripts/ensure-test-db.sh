#!/usr/bin/env bash
# Ensure the integration test database exists and is migrated, then write the
# DATABASE_URL the test:integration script loads. Idempotent: safe to re-run.
set -euo pipefail
DB_URL="${TEST_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/job_scanner_test}"

# node-pg-migrate only runs migrations; it does not create the database. Create
# it first (connecting to the admin "postgres" database) if it is missing.
DB_NAME="$(basename "${DB_URL%%\?*}")"
ADMIN_URL="${DB_URL%/*}/postgres"
if ! psql "$ADMIN_URL" -tAc \
  "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
  psql "$ADMIN_URL" -c "create database \"$DB_NAME\""
fi

echo "DATABASE_URL=$DB_URL" >.env.test
DATABASE_URL="$DB_URL" npm run migrate:up
