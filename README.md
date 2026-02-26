# Nexa

Private self-hosted web app for URL and file conversion (audio, video, and documents).

Built with Next.js + BullMQ worker + Redis + PostgreSQL, designed to run on a VPS with Docker Compose.

## Screenshots

### URL conversion
![Nexa URL conversion](docs/screenshots/dashboard-url.png)

### File conversion
![Nexa file conversion](docs/screenshots/dashboard-file.png)

### Mobile view
![Nexa mobile view](docs/screenshots/dashboard-mobile.png)

## Features

- URL conversion (YouTube, SoundCloud, Vimeo, Bandcamp)
- File conversion via upload (drag and drop)
- Audio/video/document output formats
- Async queue processing (BullMQ + Redis)
- Job tracking with statuses (`queued`, `processing`, `done`, `failed`, `expired`, `canceled`)
- Automatic cleanup after 24h
- Optional authentication mode (`AUTH_REQUIRED=true`)
- IP-isolated sessions when auth is disabled
- Rate limiting and optional CAPTCHA on URL submit

## Supported formats

- URL outputs: `mp3`, `aac`, `ogg`, `wav`, `mp4`, `webm`, `mkv`
- Upload outputs: `mp3`, `aac`, `ogg`, `wav`, `mp4`, `webm`, `mkv`, `pdf`, `docx`, `txt`
- Media quality presets:
  - Audio: `low`, `standard`, `high`
  - Video: `p720`, `p1080`

## Architecture

- `apps/web`: Next.js UI + API routes
- `apps/worker`: queue consumer + converters (`ffmpeg`, `yt-dlp`, `libreoffice`)
- `postgres`: jobs, files, users, audit events
- `redis`: BullMQ queue backend
- `caddy`: reverse proxy and TLS termination

## Quick start (Docker)

### 1. Clone

```bash
git clone [<your-repo-url>](https://github.com/leosamp05/nexa.git)
cd nexa
```

### 2. Configure environment

Create `.env` in project root:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/convertitore?schema=public
REDIS_URL=redis://redis:6379
SESSION_SECRET=<long-random-secret>
APP_URL=http://localhost:3000
APP_DOMAIN=localhost
DATA_DIR=/app/storage
MAX_UPLOAD_BYTES=524288000
MAX_DURATION_SECONDS=3600
JOB_TIMEOUT_MS=900000
RATE_LIMIT_WINDOW_SEC=60
RATE_LIMIT_MAX=25
WORKER_CONCURRENCY=2
CAPTCHA_ENABLED=false
CAPTCHA_VERIFY_URL=https://challenges.cloudflare.com/turnstile/v0/siteverify
CAPTCHA_SECRET=
CAPTCHA_SITE_KEY=
NEXT_PUBLIC_CAPTCHA_SITE_KEY=
ALLOWED_SOURCE_HOSTS=youtube.com,youtu.be,soundcloud.com,vimeo.com,bandcamp.com
BLOCKED_SOURCE_PATTERNS=music.youtube.com
AUTH_REQUIRED=false
SENTRY_DSN=
```

Optional seed user (only if you want initial credentials):

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-now
```

### 3. Start services

```bash
docker compose up -d --build
```

### 4. Open app

- `http://localhost` (redirects to HTTPS)
- `https://localhost`

Note: on first access with local TLS you may see a browser certificate warning.

## Authentication modes

### Auth disabled (default)

- `AUTH_REQUIRED=false`
- Login screen is skipped
- Session identity is auto-generated per client IP hash

### Auth enabled

- `AUTH_REQUIRED=true`
- Login and register are enabled
- Session cookie is signed with `SESSION_SECRET`

## Main API endpoints

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `POST /api/jobs/url`
- `POST /api/jobs/upload`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/download`
- `DELETE /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `GET /api/health`

## Local development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:dev -- --name init
npm run seed
npm run dev
npm run dev:worker
```

## Useful commands

```bash
# Rebuild worker after yt-dlp/ffmpeg changes
docker compose build worker && docker compose up -d worker

# Check worker logs
docker compose logs -f worker

# Check web logs
docker compose logs -f web

# Run tests
npm run test
```

## Troubleshooting

### YouTube extraction errors

If you see messages like `Precondition check failed` or `Signature extraction failed`:

```bash
docker compose build --no-cache worker
docker compose up -d worker
docker compose exec worker yt-dlp --version
```

### SoundCloud short links

Short URLs such as `https://on.soundcloud.com/...` are resolved automatically in the worker before extraction.

### Upload conversion rejected

The app validates input/output compatibility before enqueueing:

- media output requires audio/video input
- document output requires text/document input
- `pdf -> txt/docx` is currently blocked by design

## Project structure

```text
.
├── apps/
│   ├── web/
│   └── worker/
├── prisma/
├── docker/
├── docs/
│   └── screenshots/
├── docker-compose.yml
├── Dockerfile.web
└── Dockerfile.worker
```

## Notes

- This project is intended for private/self-hosted usage.
- Verify you have rights to process the content you submit.
