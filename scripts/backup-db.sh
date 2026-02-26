#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

mkdir -p /tmp/convertitore-backups
TS=$(date +%Y%m%d-%H%M%S)
OUT="/tmp/convertitore-backups/convertitore-${TS}.sql"

pg_dump "$DATABASE_URL" > "$OUT"
echo "Backup written to $OUT"
