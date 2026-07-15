#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/tmp/convertitore-backups}"
install -d -m 700 "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT=$(mktemp "${BACKUP_DIR}/convertitore-${TS}-XXXXXX.sql")

export PGDATABASE="$DATABASE_URL"
pg_dump > "$OUT"
echo "Backup written to $OUT"
