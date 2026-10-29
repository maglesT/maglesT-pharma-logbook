#!/bin/sh
# Restore check (LB-23; A11 7.2): restores a backup into a scratch database, applies migrations
# to prove the schema is current, runs the integrity check, then drops the scratch database.
# Usage: ADMIN_URL=postgres://owner:pw@host/postgres ops/restore-check.sh /backups/logbook-....dump
# ADMIN_URL must be able to create and drop databases. Run it periodically (CP-03) and record the result.
set -eu
: "${ADMIN_URL:?ADMIN_URL is required}"
dump="${1:?path to a .dump file}"
here="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$dump.sha256" ]; then (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256"); fi
scratch="logbook_restore_check_$(date -u +%Y%m%d%H%M%S)"
base="${ADMIN_URL%/*}"
psql -q "$ADMIN_URL" -c "create database $scratch"
trap 'psql -q "$ADMIN_URL" -c "drop database if exists $scratch with (force)"' EXIT
pg_restore --no-owner --dbname="$base/$scratch" "$dump"
cd "$here"
if [ -f dist/db/migrate.js ]; then run="node dist/db"; else run="npx tsx db"; fi
MIGRATION_DATABASE_URL="$base/$scratch" $run/migrate.js 2>/dev/null || MIGRATION_DATABASE_URL="$base/$scratch" $run/migrate.ts
DATABASE_URL="$base/$scratch" $run/integrity.js 2>/dev/null || DATABASE_URL="$base/$scratch" $run/integrity.ts
echo "restore check passed: $dump"
