# Nexa Runbook

## Operational checks

- Health: `GET /api/health`
- Metrics (Prometheus): `GET /api/metrics`
- Worker logs: `docker compose logs -f worker`
- Web logs: `docker compose logs -f web`

## Backup and restore

### Backup

```bash
DATABASE_URL='postgresql://...' bash scripts/backup-db.sh
```

### Restore

```bash
psql 'postgresql://...' < /tmp/convertitore-backups/convertitore-YYYYMMDD-HHMMSS.sql
```

## Incident response

### Queue backlog growing

1. Check `GET /api/metrics` values for `nexa_queue_jobs{state="waiting"}`.
2. Check worker logs for conversion failures.
3. Scale worker concurrency (`WORKER_CONCURRENCY`) and restart worker.

### High failure rate

1. Check `nexa_jobs_total{status="failed"}` and recent audit events.
2. Verify converter binaries (`ffmpeg`, `yt-dlp`, `libreoffice`) in worker image.
3. Rebuild worker image with latest dependencies:

```bash
docker compose build --no-cache worker
docker compose up -d worker
```

### URL rejected by policy

1. Confirm host is in `ALLOWED_SOURCE_HOSTS`.
2. Confirm host is not in `BLOCKED_SOURCE_PATTERNS`.
3. Confirm DNS does not resolve to private/local IP ranges.

### Upload blocked by security checks

1. Verify file MIME is consistent (declared vs detected signature).
2. If `ANTIVIRUS_ENABLED=true`, ensure `clamscan` is installed in runtime.
3. Inspect web logs for `Antivirus scan failed` entries.

## Upgrade procedure

1. Pull latest code.
2. Run migrations:

```bash
npm run prisma:migrate
```

3. Rebuild and restart services:

```bash
docker compose up -d --build
```

4. Validate `/api/health` and `/api/metrics`.
