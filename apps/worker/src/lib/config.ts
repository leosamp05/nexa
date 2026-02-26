import path from "node:path";

function n(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(raw: string | undefined, fallback: string[]) {
  if (!raw) return fallback;
  return raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  redisUrl: process.env.REDIS_URL ?? "",
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "..", "..", "storage")),
  maxDurationSeconds: n(process.env.MAX_DURATION_SECONDS, 3600),
  jobTimeoutMs: n(process.env.JOB_TIMEOUT_MS, 900000),
  workerConcurrency: n(process.env.WORKER_CONCURRENCY, 2),
  cleanupIntervalMs: 60 * 60 * 1000,
  allowedHosts: list(process.env.ALLOWED_SOURCE_HOSTS, [
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "www.soundcloud.com",
    "vimeo.com",
    "www.vimeo.com",
    "bandcamp.com",
    "www.bandcamp.com",
  ]),
  blockedPatterns: list(process.env.BLOCKED_SOURCE_PATTERNS, []),
};
