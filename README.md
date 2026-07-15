# Nexa

[![CI](https://github.com/leosamp05/nexa/actions/workflows/ci.yml/badge.svg)](https://github.com/leosamp05/nexa/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

Nexa is a private, self-hosted web application for converting media from supported URLs and converting uploaded audio, video, and document files. It combines a Next.js UI/API with a BullMQ worker, PostgreSQL, Redis, and a shared filesystem, and is designed to run on a single Docker Compose host.

## At a glance

- URL extraction from YouTube, SoundCloud, Vimeo, and Bandcamp through `yt-dlp`
- Streaming file uploads with drag-and-drop support and a 500 MiB default limit
- Audio, video, and document conversion through FFmpeg, LibreOffice, and Poppler
- Asynchronous processing, bounded retries, cancellation, job history, and downloads
- Optional account authentication, Cloudflare Turnstile, antivirus scanning, and Caddy TLS
- URL allowlisting, DNS and egress SSRF defenses, MIME-family checks, and path containment
- JSON health checks, Prometheus-format metrics, structured logs, and database audit events
- Automatic artifact expiry and cleanup after 24 hours

Nexa is intended for controlled self-hosted use. The default configuration is local-only and has authentication disabled; review [Security](#security) before exposing it to a network.

## Screenshots

| URL conversion | File conversion |
| --- | --- |
| ![Nexa URL conversion](docs/screenshots/dashboard-url.png) | ![Nexa file conversion](docs/screenshots/dashboard-file.png) |

Screenshots use demonstration data; do not publish captures from a real instance without reviewing URLs, IP addresses, filenames, and job metadata.

## Contents

- [Supported conversions](#supported-conversions)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage and HTTP endpoints](#usage-and-http-endpoints)
- [Configuration](#configuration)
- [Operations](#operations)
- [Security](#security)
- [Testing and releases](#testing-and-releases)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)

## Supported conversions

### URL sources

The default source policy accepts these services and their subdomains:

| Source | Audio output | Video output | Notes |
| --- | --- | --- | --- |
| YouTube | `mp3`, `aac`, `ogg`, `wav` | `mp4`, `webm`, `mkv` | `music.youtube.com` is blocked by the example policy |
| Vimeo | `mp3`, `aac`, `ogg`, `wav` | `mp4`, `webm`, `mkv` | Public URLs supported by the installed `yt-dlp` version |
| SoundCloud | `mp3`, `aac`, `ogg`, `wav` | No | Includes subdomains such as `on.soundcloud.com` |
| Bandcamp | `mp3`, `aac`, `ogg`, `wav` | No | Artist subdomains are accepted by the default host policy |

URL jobs process one item only: playlists are disabled and only the first item is selected. Availability still depends on the source being reachable and supported by the `yt-dlp` version built into the worker.

### Uploaded files

| Input family | Recognized examples | Valid outputs |
| --- | --- | --- |
| Audio | MP3, AAC, OGG, WAV, FLAC, M4A/M4B, WebA | `mp3`, `aac`, `ogg`, `wav` |
| Video | MP4, MOV, AVI, OGV, WebM, MKV | `mp3`, `aac`, `ogg`, `wav`, `mp4`, `webm`, `mkv` |
| Document or text | PDF, DOC, DOCX, TXT, RTF, ODT | `pdf`, `docx`, `txt` |

The server admits media by MIME family and documents by a fixed MIME allowlist; the extensions above are the formats explicitly recognized by the UI and filename inference. Successful conversion also depends on FFmpeg or LibreOffice supporting the input contents.

Important conversion behavior:

- Audio inputs cannot produce video outputs; video inputs can produce either audio or video.
- Media is re-encoded even when the input and output extensions match.
- `low`, `standard`, and `high` target 128, 192, and 256 kbit/s for MP3/AAC; OGG uses corresponding Vorbis quality levels. WAV is uncompressed PCM.
- `p720` and `p1080` are maximum dimensions. Smaller videos are not upscaled.
- PDF-to-TXT uses `pdftotext -layout`; PDF-to-DOCX extracts text first and then creates a DOCX with LibreOffice.
- There is no OCR pipeline. Scanned or image-only PDFs may therefore produce little or no text.
- Converting a document to the same format copies it; DOCX/ODT archives converted through LibreOffice are checked for unsafe expansion characteristics.

Default limits are 500 MiB per upload, 500 MiB per remote download, one hour of media duration, and 15 minutes per converter command. All are configurable.

## Architecture

```mermaid
flowchart LR
    Client["Browser or API client"] --> Caddy["Caddy (optional TLS proxy)"]
    Client -. "local/direct access" .-> Web["Next.js web and API"]
    Caddy --> Web
    Web --> Postgres["PostgreSQL"]
    Web --> Redis["Redis / BullMQ"]
    Web <--> Storage["Shared storage directory"]
    Redis --> Worker["BullMQ worker"]
    Worker --> Postgres
    Worker <--> Storage
    Worker --> Tools["yt-dlp, FFmpeg, LibreOffice, pdftotext"]
```

1. The web service authenticates the caller, validates the request, persists a job in PostgreSQL, and enqueues its ID in Redis.
2. Uploads are streamed to a private temporary path, hashed, validated, and moved into the per-job storage directory before enqueueing.
3. The worker atomically claims the database job. URL downloads are routed through a local validating egress proxy; uploads are read from shared storage.
4. The selected converter writes into an isolated run directory. The worker hashes and records the completed artifact, then publishes the final job state.
5. The web service streams owned artifacts to the client. An hourly worker sweep removes expired terminal-job files and marks their records `expired`.

PostgreSQL stores users, jobs, artifact metadata, and audit events. Redis stores the BullMQ queue and rate-limit counters. File bytes live under `DATA_DIR`; in Compose this is the host `./storage` directory mounted into both application containers.

## Installation

### Recommended: guided Docker installer

Prerequisites:

- Git
- Docker Engine or Docker Desktop with Compose v2; legacy `docker-compose` is also detected
- Bash 3.2 or newer
- Node.js 24+ and npm to use the `npm run setup` wrapper and native `--env-file` commands
- A DNS name pointing at the host, plus reachable ports 80/443, when enabling public Caddy TLS

```bash
git clone https://github.com/leosamp05/nexa.git
cd nexa
npm run setup
```

On a Docker-only host without Node.js, invoke the same installer directly:

```bash
bash scripts/install.sh
```

The installer writes `.env`, creates `storage/`, generates independent runtime secrets, and asks for:

- `Development` or `Production` profile
- Docker (recommended) or native Node.js development mode
- application host and port
- whether login authentication is required
- optional Caddy on ports 80/443 in Docker mode
- public self-registration policy and initial admin credentials when authentication is enabled

The development profile defaults to `AUTH_REQUIRED=false` and `LOG_LEVEL=debug`; production defaults to `AUTH_REQUIRED=true` and `LOG_LEVEL=info`. Every choice remains interactive.

Docker mode builds and starts PostgreSQL, Redis, web, and worker, plus Caddy when selected. Native mode is development-only: it installs dependencies, generates Prisma Client, deploys migrations, invokes the seed command with the root `.env`, and prints two explicit environment-aware development commands; it does not leave the web or worker running.

Without Caddy, open `http://HOST:PORT` (default `http://localhost:3001`). With Caddy, open `https://APP_DOMAIN`. Use HTTPS for non-local authenticated deployments because production session cookies are marked `Secure`.

### Manual Docker setup

Create the environment file and replace both documented secret placeholders:

```bash
cp .env.example .env
bash scripts/install.sh --ensure-secrets
```

Review `.env` before starting. At minimum, choose the exposure and authentication model and set `APP_DOMAIN` for Caddy. When authentication is enabled and public registration remains disabled, configure the initial admin seed or the instance will have no login path.

The Compose database name, user, password, and app-container connection URL are fixed in `docker-compose.yml`; changing only `DATABASE_URL` in `.env` does not reconfigure that internal database. PostgreSQL and Redis are not published on host ports by the supplied stack.

Start the core stack without Caddy:

```bash
docker compose up -d --build postgres redis web worker
```

The default `APP_BIND_IP=127.0.0.1` keeps port 3001 local to the host. Set it to `0.0.0.0` only when direct network access is intentional and protected.

To use the included TLS proxy, keep the direct web port on loopback, set `APP_DOMAIN` to the DNS name, and include Caddy:

```bash
docker compose up -d --build postgres redis web worker caddy
```

The web container generates Prisma Client, deploys migrations, and runs `npm run seed` at startup. The seed is skipped when `ADMIN_EMAIL` or `ADMIN_PASSWORD` is empty; otherwise it upserts that account and requires a unique password of at least 12 characters. Clear seed credentials from `.env` and recreate the web container after the initial seed so the password is not retained in long-lived configuration.

Verify the deployment:

```bash
docker compose ps
docker compose logs --tail=100 web worker
curl -i http://127.0.0.1:3001/api/health
```

Use the HTTPS domain instead of the direct URL when Caddy is enabled. With `APP_DOMAIN=localhost`, Caddy uses its internal CA; clients do not trust that certificate automatically.

### Local development

Native conversion requires Node.js 24+, PostgreSQL, Redis, FFmpeg/FFprobe, `yt-dlp`, LibreOffice (`soffice`), and Poppler (`pdftotext`) on the host. `clamscan` is additionally required only when antivirus scanning is enabled.

The guided installer can prepare native mode. For a manual setup:

```bash
cp .env.example .env
bash scripts/install.sh --ensure-secrets
```

Change the service addresses and storage path in `.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/convertitore?schema=public
REDIS_URL=redis://localhost:6379
DATA_DIR=/absolute/path/to/nexa/storage
APP_BIND_IP=localhost
APP_PORT=3001
```

```bash
npm ci --legacy-peer-deps
npm run prisma:generate
npm run prisma:migrate
node --env-file=.env ./node_modules/tsx/dist/cli.mjs scripts/seed-admin.ts
```

Prisma CLI loads the root `.env`; the seed and workspace runtimes do not load it completely. Start the processes in separate shells with Node's explicit environment-file support:

```bash
# terminal 1
cd apps/web
node --env-file=../../.env ../../node_modules/next/dist/bin/next dev --hostname localhost --port 3001
```

```bash
# terminal 2
cd apps/worker
node --env-file=../../.env ../../node_modules/tsx/dist/cli.mjs src/index.ts
```

Use `npm run prisma:migrate:dev` only when authoring a new development migration; normal setup and deployment use `npm run prisma:migrate`.

## Usage and HTTP endpoints

From the dashboard:

1. Choose URL or file input, then audio, video, or document mode.
2. Select an output and the applicable quality preset.
3. Submit the URL or drop one file. Accepted jobs enter the BullMQ queue.
4. The job table refreshes every five seconds and shows attempts, retries, failures, and terminal states.
5. Download completed output, cancel an active job, or delete a terminal job.

The UI uses these server endpoints. Job endpoints always scope data to the current account or auth-disabled identity.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Create a signed session when auth is enabled |
| `POST` | `/api/auth/register` | Self-register a `USER` account only when auth and registration are enabled |
| `POST` | `/api/auth/logout` | Clear the session |
| `POST` | `/api/jobs/url` | Submit a JSON URL conversion request |
| `POST` | `/api/jobs/upload` | Stream one `multipart/form-data` upload |
| `GET` | `/api/jobs` | List the newest 100 owned jobs |
| `GET` | `/api/jobs/:id` | Read one owned job |
| `POST` | `/api/jobs/:id/cancel` | Cancel a queued or processing job |
| `DELETE` | `/api/jobs/:id` | Delete a non-active job and its directory |
| `GET` | `/api/jobs/:id/download` | Stream a completed, unexpired output |
| `GET` | `/api/health` | Check database, Redis, and queue health |
| `GET` | `/api/metrics` | Export aggregate Prometheus-format metrics |

Job states are `queued`, `processing`, `done`, `failed`, `canceled`, and `expired`. Only transient network failures are retried; deterministic conversion and validation failures become terminal immediately.

## Configuration

`.env.example` is the source of truth for deployable variables. Never commit `.env`.

### Runtime and deployment

| Variable | Example/default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | Compose PostgreSQL URL | Prisma connection string; Compose overrides it inside app containers |
| `REDIS_URL` | `redis://redis:6379` | BullMQ and rate-limit Redis connection; required by the worker |
| `SESSION_SECRET` | generated | HS256 session secret; at least 32 random characters when auth is enabled |
| `TRUSTED_PROXY_TOKEN` | generated separately | Shared Caddy/web token that authenticates forwarded client-IP headers; at least 32 characters |
| `APP_URL` | `http://localhost:3001` | Installer/deployment metadata; not currently read by application code |
| `APP_DOMAIN` | `localhost` | Caddy site address and certificate name |
| `APP_BIND_IP` | `127.0.0.1` | Host interface used for the direct Compose web port |
| `APP_PORT` | `3001` | Host port mapped to Next.js port 3000 |
| `DATA_DIR` | `/app/storage` in Compose | Shared job and temporary-upload root |
| `AUTH_REQUIRED` | `false` | Enable signed-cookie login |
| `REGISTRATION_ENABLED` | `false` | Allow public self-registration of non-admin `USER` accounts |
| `LOG_LEVEL` | `info` | Pino log level for web and worker |
| `ADMIN_EMAIL` | empty | Optional account seeded/upserted during web startup |
| `ADMIN_PASSWORD` | empty | Optional seed password; minimum 12 characters |

### Limits, queue, and policy

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `524288000` | Maximum uploaded file size; request allowance adds 1 MiB multipart overhead |
| `MAX_REMOTE_DOWNLOAD_BYTES` | `524288000` | `yt-dlp` maximum source download size; falls back to upload limit in code |
| `MAX_DURATION_SECONDS` | `3600` | Maximum probed media duration for URL and upload jobs |
| `JOB_TIMEOUT_MS` | `900000` | Timeout for download and converter commands |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Default Redis rate-limit window |
| `RATE_LIMIT_MAX` | `25` | Default per-IP request budget; selected routes add tighter user/account budgets |
| `QUEUE_ATTEMPTS` | `3` | Maximum BullMQ attempts recorded on each job |
| `QUEUE_RETRY_DELAY_MS` | `5000` | Initial exponential-backoff delay |
| `WORKER_CONCURRENCY` | `2` | Concurrent jobs in one worker process |
| `ALLOWED_SOURCE_HOSTS` | YouTube, SoundCloud, Vimeo, Bandcamp | Comma-separated initial URL host allowlist |
| `BLOCKED_SOURCE_PATTERNS` | `music.youtube.com` | Comma-separated URL/host deny patterns applied before allowlisting |

### Optional protections and integrations

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAPTCHA_ENABLED` | `false` | Require Turnstile-compatible verification for URL submissions only |
| `CAPTCHA_VERIFY_URL` | Cloudflare Turnstile endpoint | Server-side token verification endpoint |
| `CAPTCHA_SECRET` | empty | Server-side CAPTCHA secret |
| `CAPTCHA_SITE_KEY` | empty | Server-side fallback site key |
| `NEXT_PUBLIC_CAPTCHA_SITE_KEY` | empty | Preferred site key exposed to the dashboard |
| `ANTIVIRUS_ENABLED` | `false` | Run `clamscan` on uploads and fail closed on scan errors |
| `SENTRY_DSN` | empty | Reserved in `.env.example`; no current application code consumes it |

When using another reverse proxy, preserve the direct port's network isolation. Only Caddy's exact `X-Nexa-Proxy-Token` contract is trusted for client identity; arbitrary `X-Forwarded-For`, `X-Real-IP`, and `CF-Connecting-IP` headers are otherwise ignored.

## Operations

### Health, metrics, and logs

```bash
curl -i http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/metrics
docker compose logs -f web worker
```

`/api/health` returns HTTP 200 with `status: "ok"`, or 503 with `status: "degraded"`, and reports database, Redis, and queue checks. It does not check worker readiness or converter binaries. `/api/metrics` exports:

- `nexa_uptime_seconds`
- `nexa_jobs_total{status="..."}`
- `nexa_job_duration_avg_seconds`
- `nexa_queue_jobs{state="..."}` when Redis is reachable

Both endpoints are unauthenticated. Restrict them at the network/proxy layer if aggregate workload information should not be public.

### Service lifecycle and upgrades

```bash
docker compose ps
docker compose logs --tail=200 -f worker
docker compose up -d --build postgres redis web worker
```

Include `caddy` in the last command when it is part of the deployment. Container startup deploys pending migrations. After changing environment variables, recreate the affected service so it receives the new environment.

Increase `WORKER_CONCURRENCY` cautiously: every concurrent job can run a downloader and converter and consume significant CPU, memory, disk, and network bandwidth.

### Persistence, retention, and backups

- PostgreSQL data uses the `pgdata` named volume.
- Redis uses append-only persistence in the `redisdata` named volume.
- Artifacts and in-progress files use the host `./storage` bind mount.
- Caddy certificates and state use `caddy_data` and `caddy_config`.
- Completed outputs expire 24 hours after completion. Failed and canceled jobs retain their submission-time expiry. The hourly sweep removes terminal-job directories and marks database jobs `expired`.

For the Compose database:

```bash
docker compose exec -T postgres pg_dump -U postgres -d convertitore > nexa.sql
docker compose exec -T postgres psql -U postgres -d convertitore < nexa.sql
```

For any PostgreSQL instance reachable from the host, the bundled script creates a private, unpredictable backup file:

```bash
DATABASE_URL='postgresql://...' BACKUP_DIR=/secure/backup/path bash scripts/backup-db.sh
psql 'postgresql://...' < /secure/backup/path/convertitore-TIMESTAMP-RANDOM.sql
```

A database dump does not contain artifact bytes. Back up `storage/` as well, and preserve Redis if in-flight queue state matters. Coordinate snapshots if a consistent database/filesystem point-in-time is required.

The more detailed incident and upgrade checklist is in [docs/runbook.md](docs/runbook.md).

## Security

- **Network exposure:** Compose binds the web service to loopback by default. Keep that setting behind Caddy. Do not expose direct HTTP with `AUTH_REQUIRED=false` to untrusted users.
- **Auth-disabled identity:** behind the included Caddy with a valid proxy token, jobs are partitioned by a hash of the authenticated client IP. Direct requests intentionally share the stable `direct` identity because Next.js route handlers cannot verify the peer IP. Direct multi-user access therefore shares job history and downloads.
- **Authentication:** enabled mode uses Argon2 password hashes and a seven-day signed, HTTP-only, same-site cookie. Docker production cookies are `Secure`, so non-local deployments need HTTPS. Public registration is disabled by default; when explicitly enabled, new accounts receive the non-admin `USER` role. The optional seed is the only path that promotes an account to `ADMIN`.
- **Secrets:** `SESSION_SECRET` and `TRUSTED_PROXY_TOKEN` must be independent random values. `scripts/install.sh --ensure-secrets` replaces the documented placeholders. Never publish `.env` or retain an initial seed password longer than necessary.
- **Source URL defense:** admission permits only HTTP(S), ports 80/443, configured hosts, and public DNS results. The worker repeats validation and forces every `yt-dlp` request through an address-pinning proxy that rejects private and special-use destinations, including redirects to local networks.
- **Upload defense:** uploads are streamed with bounded multipart fields, byte limits, mode-0600 temporary files, SHA-256 hashes, signature-based type detection, MIME-family checks, sanitized names, and data-directory path containment.
- **Document defense:** converted DOCX/ODT ZIP metadata is bounded before LibreOffice to reduce archive-expansion abuse. Converter commands have timeouts, bounded captured output, process-tree cancellation, and isolated run directories.
- **Rate limiting and CAPTCHA:** Redis counters protect submissions and auth routes. Rate limiting fails open if Redis errors; URL jobs still cannot enqueue without Redis. CAPTCHA applies only to URL submissions.
- **Antivirus:** `ANTIVIRUS_ENABLED=true` requires `clamscan` and current signatures in the **web** runtime. The stock `Dockerfile.web` does not install ClamAV, so enabling it unchanged rejects uploads with `Antivirus scan failed`; build a custom web image first.
- **Reverse proxy:** the included Caddy configuration limits request bodies, sets HSTS/CSP and other browser headers, strips untrusted Cloudflare IP headers, overwrites forwarding headers, and injects a separate bearer-style `TRUSTED_PROXY_TOKEN` known to the web service. Keep the direct web port unreachable to clients.

Converters process untrusted and potentially copyrighted content. Keep system packages and images current, restrict access, monitor resource usage, and only process content you are authorized to use.

## Testing and releases

Install exactly from the lockfile and generate Prisma Client before running checks:

```bash
npm ci --legacy-peer-deps
npm run prisma:generate
npx playwright install --with-deps chromium
npm run test
npm run test:e2e
npm run build
```

`npm run test` runs the web and worker Vitest suites. They cover request boundaries, upload streaming, storage containment, SSRF/egress policy, conversion behavior, retries, cancellation, cleanup, and deployment safety. `npm run test:e2e` starts the web app on port 3010 and performs the health smoke test; a degraded dependency result is accepted as long as the endpoint contract is valid, so it does not prove worker or converter readiness.

With `.env` present, validate deployment configuration and images using the same commands as CI:

```bash
docker compose config -q
docker build -f Dockerfile.web -t nexa-web:ci .
docker build -f Dockerfile.worker -t nexa-worker:ci .
```

The `CI` workflow runs install, Prisma generation, unit tests, the E2E smoke test, both workspace builds, Compose validation, and both Docker builds on pushes and pull requests.

Tags matching `v*` trigger `release-packages.yml`, which publishes web and worker images to GHCR with the tag and `latest`, then creates a GitHub Release. The checked-in `docker-compose.yml` builds local Dockerfiles; it does not pull those release images automatically.

## Troubleshooting

### The installer cannot find Docker Compose

Confirm either `docker compose version` or the legacy `docker-compose` command works in the same shell. The installer does not install Docker itself.

### Health is degraded or jobs remain queued

```bash
docker compose ps
docker compose logs --tail=200 postgres redis web worker
curl -i http://127.0.0.1:3001/api/health
```

Database or Redis failures are reported by health. A growing waiting queue with healthy dependencies usually means the worker is stopped, repeatedly failing, or undersized. Check disk capacity and verify `ffmpeg`, `ffprobe`, `yt-dlp`, `soffice`, and `pdftotext` in the worker runtime.

### YouTube reports extraction or signature errors

The worker image downloads the latest `yt-dlp` binary when it is built. Refresh it with a clean worker build:

```bash
docker compose build --no-cache worker
docker compose up -d worker
docker compose exec worker yt-dlp --version
```

### A URL is rejected

Check `ALLOWED_SOURCE_HOSTS` and `BLOCKED_SOURCE_PATTERNS`, use only HTTP(S) on port 80/443, and confirm every DNS result is public. `music.youtube.com` is blocked by `.env.example`. SoundCloud and Bandcamp accept audio outputs only.

### An upload is rejected or conversion is impossible

Check the byte and duration limits, declared versus detected MIME family, and the input/output matrix above. Video output requires video input; document output requires document/text input. If antivirus is enabled, confirm `clamscan` exists in the web container and has usable signatures.

### PDF-to-TXT or PDF-to-DOCX output is empty or poorly formatted

The pipeline extracts embedded text and does not perform OCR. Confirm the PDF contains a text layer. DOCX creation is text-based and is not a pixel-perfect reconstruction of the PDF layout.

### Login succeeds but returns to the login page

Use HTTPS in production so the browser sends the `Secure` session cookie. Also ensure `SESSION_SECRET` is at least 32 random characters and is identical across web container recreations.

### Clients share jobs or the UI shows the wrong IP bucket

Direct auth-disabled requests share one identity by design. Use the included Caddy proxy and ensure the same independent `TRUSTED_PROXY_TOKEN` is present in both Caddy and web. Keep port 3001 bound to `127.0.0.1` so clients cannot bypass the proxy.

### Native worker cannot connect or ignores `.env`

Use the explicit `node --env-file=...` commands in [Local development](#local-development). In native mode, `DATABASE_URL` and `REDIS_URL` must use reachable host addresses such as `localhost`, not Compose service names.

## Project structure

```text
.
├── apps/
│   ├── web/                 # Next.js UI, API routes, auth, admission checks
│   └── worker/              # BullMQ consumer, egress proxy, converters, cleanup
├── docker/caddy/Caddyfile   # Optional TLS reverse proxy and security headers
├── docs/                    # Operational runbook and screenshots
├── prisma/                  # Schema and SQL migrations
├── scripts/                 # Installer, account seed, database backup
├── tests/e2e/               # Playwright health smoke test
├── docker-compose.yml       # PostgreSQL, Redis, web, worker, Caddy
├── Dockerfile.web
└── Dockerfile.worker
```

## License and responsible use

Nexa is licensed under the [GNU Affero General Public License v3.0](LICENSE).

You are responsible for complying with source-service terms, copyright law, privacy obligations, and any other rules that apply to the content you submit or operate Nexa against.
