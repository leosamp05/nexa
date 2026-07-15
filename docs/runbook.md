# Nexa operations runbook

This runbook covers the supplied single-host Docker Compose deployment and the native Node.js mode. Run commands from the repository root. Replace example URLs and backup paths before use.

## Safety and deployment facts

- Core Compose services are `postgres`, `redis`, `web`, and `worker`; `caddy` is optional.
- Always name services in `docker compose up` commands. Caddy is profile-gated; the explicit core list prevents accidental activation and remains safe if profiles or configuration change.
- PostgreSQL uses the `pgdata` volume, Redis uses `redisdata`, and application bytes use the host `./storage` bind mount.
- The database records artifact paths and job state; a recoverable checkpoint therefore needs both PostgreSQL and `storage/`.
- The procedures below exclude Redis deliberately and require an empty queue. Redis then contains no irreplaceable in-flight work and is reset during restore.
- Caddy state is not included; certificates can be reissued. Keep the repository revision and `.env` with each checkpoint.
- Never run `docker compose down -v`: it deletes named persistent volumes.
- **DESTRUCTIVE** marks commands that replace or erase persistent state. Verify the target host, Compose project, backup, and current directory first.

## Routine status and verification

Set the URL to the direct loopback port, or to the HTTPS domain when Caddy is the intended path:

```bash
BASE_URL=http://127.0.0.1:3001
docker compose --profile caddy ps --all
docker compose logs --tail=100 postgres redis web worker
curl -i "$BASE_URL/api/health"
curl -fsS "$BASE_URL/api/metrics" | grep -E 'nexa_(jobs_total|queue_jobs|job_duration_avg_seconds)'
```

Healthy means `/api/health` returns HTTP 200, `status: "ok"`, and `db`, `redis`, and `queue` are `ok`. A 503 response identifies the failed dependency. The endpoint does **not** check worker readiness or converter binaries.

Verify the worker independently:

```bash
docker compose ps worker
docker compose logs worker | grep -F 'Worker ready' | tail -n 1
docker compose logs --since=15m worker | grep -E 'Worker bootstrap failed|Queue job failed|Queue job stalled|Job failed' || true
```

The container must be running and its current startup must reach `Worker ready`. There is no worker health endpoint. After a restart, use `--since` to ensure the readiness line belongs to that startup.

Verify converter presence and versions in the worker image:

```bash
docker compose exec -T worker sh -lc '
  ffmpeg -version | head -n 1
  ffprobe -version | head -n 1
  yt-dlp --version
  soffice --version
  pdftotext -v 2>&1 | head -n 1
'
```

Finish release or recovery validation with a small, authorized UI job and confirm `queued` -> `processing` -> `done` plus a successful download. This is the only check that covers every component; no repository smoke-job script exists.

## Docker checkpoint

Use a maintenance window. Stop Caddy if deployed (keep the direct loopback URL for checks), wait for metrics to show `waiting=0`, `active=0`, and `delayed=0`, and confirm PostgreSQL has no active job rows:

```bash
docker compose --profile caddy stop caddy # only if deployed
curl -fsS "$BASE_URL/api/metrics" | grep 'nexa_queue_jobs'
docker compose exec -T postgres psql -U postgres -d convertitore -Atc \
  "SELECT status, count(*) FROM \"Job\" WHERE status IN ('queued','processing') GROUP BY status;"
```

The query must return no rows. If the queue cannot be drained, do not use this procedure: the repository has no coordinated database/filesystem/Redis snapshot automation.

Record whether Caddy was running, stop all writers, and use an absolute backup path outside `storage/`:

```bash
docker compose stop web worker
umask 077
BACKUP_ROOT=/secure/nexa-backups
SNAPSHOT="$BACKUP_ROOT/nexa-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAPSHOT"
docker compose exec -T postgres pg_dump -U postgres -d convertitore -Fc > "$SNAPSHOT/database.dump"
tar -C "$(pwd)/storage" -czf "$SNAPSHOT/storage.tar.gz" .
cp .env "$SNAPSHOT/env"
git rev-parse HEAD > "$SNAPSHOT/git-commit.txt"
# Non-destructive archive checks
docker compose exec -T postgres pg_restore --list < "$SNAPSHOT/database.dump" > "$SNAPSHOT/database.list"
tar -tzf "$SNAPSHOT/storage.tar.gz" >/dev/null
test -s "$SNAPSHOT/database.dump" && test -s "$SNAPSHOT/storage.tar.gz"
```

The snapshot contains secrets and user data; restrict access and retention. Use the saved `env` only after reviewing it, never overwrite a live `.env` blindly. On failure, do not label the snapshot usable. After success, restart only previously enabled services:

```bash
docker compose up -d postgres redis web worker
# Only if Caddy was running before maintenance
docker compose --profile caddy up -d --no-deps caddy
```

Archive checks detect gross corruption, not logical recoverability. Periodically restore into an isolated environment and run the full verification checklist.

## Docker restore

Restore only into the revision recorded in `git-commit.txt` or a version explicitly known to accept that schema. Ensure enough space for the archive, extracted storage, and the retained pre-restore directory.

Validate and stage storage before downtime:

```bash
SNAPSHOT=/secure/nexa-backups/nexa-YYYYMMDD-HHMMSS
test -s "$SNAPSHOT/database.dump" && test -s "$SNAPSHOT/storage.tar.gz"
docker compose exec -T postgres pg_restore --list < "$SNAPSHOT/database.dump" >/dev/null
RESTORE_DIR=$(mktemp -d "$(pwd)/storage.restore.XXXXXX")
tar -xzf "$SNAPSHOT/storage.tar.gz" -C "$RESTORE_DIR"
```

Then stop writers and restore. The following database recreation, storage swap, and Redis flush are **DESTRUCTIVE** and discard all changes after the checkpoint:

```bash
# Stop this first only when Caddy is deployed
docker compose --profile caddy stop caddy
docker compose stop web worker
docker compose up -d postgres redis
# Repeat these readiness checks until both succeed
docker compose exec -T postgres pg_isready -U postgres -d convertitore
docker compose exec -T redis redis-cli PING
# DESTRUCTIVE: replace the database
docker compose exec -T postgres dropdb -U postgres --if-exists convertitore
docker compose exec -T postgres createdb -U postgres convertitore
docker compose exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges \
  -U postgres -d convertitore < "$SNAPSHOT/database.dump"
# DESTRUCTIVE: replace application bytes, retaining the previous copy for manual recovery
OLD_STORAGE="$(pwd)/storage.before-restore-$(date +%Y%m%d-%H%M%S)"
mv "$(pwd)/storage" "$OLD_STORAGE"
mv "$RESTORE_DIR" "$(pwd)/storage"
# DESTRUCTIVE: supplied Compose Redis is dedicated; clear stale queue/rate-limit state
docker compose exec -T redis redis-cli FLUSHALL
```

Keep services stopped if any step fails. Ensure `ADMIN_EMAIL`/`ADMIN_PASSWORD` are empty unless reseeding is intentional; then start `web`, inspect migration/seed logs, and start the worker. Start Caddy only if it was previously enabled:

```bash
docker compose up -d --no-deps web
docker compose logs --tail=100 web
curl -i "$BASE_URL/api/health"
docker compose up -d --no-deps worker
docker compose logs --tail=100 worker
# Only if applicable, after validation
docker compose --profile caddy up -d --no-deps caddy
```

Delete `storage.before-restore-*` only after downloads and a conversion test pass; deletion is **DESTRUCTIVE**.

## Native checkpoint and restore

Native development mode uses host PostgreSQL/Redis and the absolute `DATA_DIR` from `.env`. Restore to that same absolute path because artifact paths are stored in PostgreSQL. Drain the queue as above, then stop both native processes with the method used to start them; the repository provides no service manager.

Create a checkpoint with the bundled database script and the actual data directory. `scripts/backup-db.sh` invokes host `pg_dump`; pass a libpq-compatible host URL (normally omit Prisma's `?schema=public` and never use Compose hostname `postgres`):

```bash
umask 077
SNAPSHOT=/secure/nexa-backups/nexa-native-YYYYMMDD-HHMMSS
DATA_DIR=/absolute/path/to/nexa/storage
mkdir -p "$SNAPSHOT"
DATABASE_URL='postgresql://postgres@127.0.0.1:5432/convertitore' \
  BACKUP_DIR="$SNAPSHOT" bash scripts/backup-db.sh
tar -C "$DATA_DIR" -czf "$SNAPSHOT/storage.tar.gz" .
cp .env "$SNAPSHOT/env"
git rev-parse HEAD > "$SNAPSHOT/git-commit.txt"
DB_DUMP=$(find "$SNAPSHOT" -maxdepth 1 -name 'convertitore-*.sql' -type f -print -quit)
test -n "$DB_DUMP" && test -s "$DB_DUMP" && tar -tzf "$SNAPSHOT/storage.tar.gz" >/dev/null
```

For native restore, stage the storage archive as in Docker, stop both processes, and use administrative PostgreSQL credentials. These commands are **DESTRUCTIVE**:

```bash
DB_DUMP=/secure/nexa-backups/nexa-native-TIMESTAMP/convertitore-TIMESTAMP-RANDOM.sql
DATA_DIR=/absolute/path/to/nexa/storage
RESTORE_DIR=$(mktemp -d "$(dirname "$DATA_DIR")/storage.restore.XXXXXX")
tar -xzf /secure/nexa-backups/nexa-native-TIMESTAMP/storage.tar.gz -C "$RESTORE_DIR"

export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
dropdb --if-exists convertitore
createdb convertitore
psql -v ON_ERROR_STOP=1 -d convertitore < "$DB_DUMP"
mv "$DATA_DIR" "${DATA_DIR}.before-restore-$(date +%Y%m%d-%H%M%S)"
mv "$RESTORE_DIR" "$DATA_DIR"

# DESTRUCTIVE: only when this Redis instance is dedicated to Nexa
redis-cli -u redis://127.0.0.1:6379 FLUSHALL
```

Never run `FLUSHALL` on shared Redis. Provision a clean dedicated Redis instead; this repository has no safe key-scoped restore tool. Restart native web and worker with the explicit `node --env-file` commands or existing supervisor described in the README, then run the same health, worker-log, converter, and end-to-end checks.

## Upgrade

1. Confirm a clean deployment checkout, record `git rev-parse HEAD`, and create a verified checkpoint.
2. Review `.env.example` changes without overwriting `.env`; ensure seed credentials are empty.
3. Update code, then validate before downtime:

   ```bash
   git pull --ff-only
   docker compose --profile caddy config -q
   docker compose build web worker
   ```

4. Drain the queue. Stop Caddy only if deployed, then stop web and worker.
5. Start the explicit core list; web applies migrations before worker starts. None of these commands starts Caddy:

   ```bash
   docker compose up -d postgres redis
   docker compose up -d --no-deps web
   docker compose logs --tail=100 web
   curl -i "$BASE_URL/api/health"
   docker compose up -d --no-deps worker
   ```

6. Run all verification checks. Start `caddy` explicitly only if it was enabled before maintenance.

For native upgrades, create the native checkpoint, stop both processes, update code, run `npm ci --legacy-peer-deps`, `npm run prisma:generate`, `npm run prisma:migrate`, and `npm run build`, then restart both processes and verify.

## Rollback

- If no incompatible migration ran, check out the recorded previous commit, rebuild web/worker, and repeat the explicit startup and verification sequence. This is an application-only rollback and preserves newer data.
- Prisma deploys forward migrations and this repository has no down-migration automation. If old code cannot use the upgraded schema, check out/build the checkpoint revision and perform the **DESTRUCTIVE** database + storage restore above. This loses every post-checkpoint job and artifact and resets Redis.
- Keep Caddy stopped until health, worker readiness, converters, and an end-to-end job pass. Preserve failed-release logs and the pre-restore storage directory until the incident is closed.

## Incident response

First contain new submissions by stopping Caddy when deployed, or `web` for complete containment. Do not stop worker during an active conversion unless continued processing is unsafe; interruption can cause BullMQ redelivery/retry. Record UTC time, revision, symptoms, and retain logs securely because they can contain job identifiers and source URLs:

```bash
date -u
git rev-parse HEAD
docker compose --profile caddy ps --all
docker stats --no-stream
df -h . storage
docker compose --profile caddy logs --since=30m --timestamps postgres redis web worker caddy > /secure/nexa-incident.log
```

### Triage by symptom

- **Health degraded:** for `db=fail`, inspect PostgreSQL logs, disk, and `pg_isready`; for `redis=fail` or `queue=fail`, inspect Redis logs and run `redis-cli PING`. Do not recreate `pgdata` or flush Redis during diagnosis. Restart only the failed service after collecting evidence.
- **Queue backlog:** compare `waiting`, `active`, and `delayed` over several minutes; check worker readiness, `stalled`/`failed` logs, disk, memory, and converters. If dependencies are healthy and worker is stopped, run `docker compose up -d --no-deps worker`.
- **Worker restart:** `docker compose restart worker` can interrupt active work and cause redelivery/retry. Raise `WORKER_CONCURRENCY` only with measured CPU, memory, disk, and network headroom.
- **Conversion failures:** `nexa_jobs_total{status="failed"}` is a current-state gauge, not a rate. Correlate changes with timestamped worker logs and audit events. For YouTube extraction/signature failures, refresh `yt-dlp`:

  ```bash
  docker compose build --no-cache worker
  docker compose up -d --no-deps worker
  docker compose exec -T worker yt-dlp --version
  ```

- **Policy/antivirus:** URL rejection can be expected; check host lists, allowed ports, and public DNS before changing policy. The stock web image lacks ClamAV, so `ANTIVIRUS_ENABLED=true` rejects uploads unless a reviewed custom image supplies `clamscan` and signatures.
- **Disk/integrity:** use `df -h`, `du -sh storage`, service logs, and `docker system df`. Do not delete arbitrary `storage/jobs`: database artifact records would remain. Manual reconciliation needs a checkpoint; never delete volumes or use broad Docker pruning as remediation.

Escalate to rollback when health cannot be restored promptly, migrations fail, or integrity is uncertain. Keep the system contained and evidence intact until the rollback decision and recovery point are recorded.
