#!/bin/sh
# Restore check (LB-23; A11 7.2): verifies a backup's checksum, restores it into a scratch database,
# applies migrations to prove the schema is current, runs the integrity check, then drops the
# scratch database. Any failure stops the script with a non-zero exit.
# Usage: ADMIN_URL=postgres://owner:pw@host/postgres ops/restore-check.sh /backups/logbook-....dump
# ADMIN_URL must be able to create and drop databases. Run it periodically (CP-03) and record the result.
set -eu
: "${ADMIN_URL:?ADMIN_URL is required}"
dump="${1:?path to a .dump file}"
here="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$dump.sha256" ] || { echo "no checksum file for $dump: refusing an unverified backup" >&2; exit 1; }
(cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")

# Scratch database URL: same server and options as ADMIN_URL, different database name.
case "$ADMIN_URL" in *\?*) query="?${ADMIN_URL#*\?}"; base="${ADMIN_URL%%\?*}" ;; *) query=""; base="$ADMIN_URL" ;; esac
case "${base#*://}" in */*) ;; *) echo "ADMIN_URL must name a database, e.g. .../postgres" >&2; exit 1 ;; esac
scratch="logbook_restore_check_$(date -u +%Y%m%d%H%M%S)"
scratch_url="${base%/*}/$scratch$query"

psql -q "$ADMIN_URL" -c "create database $scratch"
trap 'psql -q "$ADMIN_URL" -c "drop database if exists $scratch with (force)"' EXIT
pg_restore --no-owner --exit-on-error --dbname="$scratch_url" "$dump"
cd "$here"
if [ -f dist/db/migrate.js ]; then
  MIGRATION_DATABASE_URL="$scratch_url" node dist/db/migrate.js
  DATABASE_URL="$scratch_url" node dist/db/integrity.js
else
  MIGRATION_DATABASE_URL="$scratch_url" npx tsx db/migrate.ts
  DATABASE_URL="$scratch_url" npx tsx db/integrity.ts
fi
echo "restore check passed: $dump"
