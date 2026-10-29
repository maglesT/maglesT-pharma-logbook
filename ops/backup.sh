#!/bin/sh
# Daily backup of the logbook database (LB-23; 211.68(b), A11 7.2).
# Writes a compressed pg_dump with a SHA-256 file and removes backups older than KEEP_DAYS.
# Usage: DATABASE_URL=postgres://owner:pw@host/logbook BACKUP_DIR=/backups ops/backup.sh
# Schedule daily, e.g. cron: 15 1 * * * /opt/logbook/ops/backup.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-365}"
mkdir -p "$BACKUP_DIR"
name="logbook-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Dump to a temporary name; only a complete dump with its checksum gets the final name.
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/$name.tmp" "$DATABASE_URL"
mv "$BACKUP_DIR/$name.tmp" "$BACKUP_DIR/$name"
# The checksum file names the dump without a path, so it verifies from inside BACKUP_DIR.
(cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256")
find "$BACKUP_DIR" -name 'logbook-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $BACKUP_DIR/$name"
