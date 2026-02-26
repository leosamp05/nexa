import path from "node:path";

export const OUTPUT_FORMATS = ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv", "pdf", "docx", "txt"] as const;
export const URL_OUTPUT_FORMATS = ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv"] as const;
export const AUDIO_QUALITY = ["low", "standard", "high"] as const;
export const VIDEO_QUALITY = ["p720", "p1080"] as const;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export const appConfig = {
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "..", "..", "storage")),
  maxUploadBytes: parseNumber(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024),
  maxDurationSeconds: parseNumber(process.env.MAX_DURATION_SECONDS, 3600),
  jobTimeoutMs: parseNumber(process.env.JOB_TIMEOUT_MS, 900_000),
  rateLimitWindowSec: parseNumber(process.env.RATE_LIMIT_WINDOW_SEC, 60),
  rateLimitMax: parseNumber(process.env.RATE_LIMIT_MAX, 25),
  captchaEnabled: parseBool(process.env.CAPTCHA_ENABLED, false),
  captchaSecret: process.env.CAPTCHA_SECRET ?? "",
  captchaVerifyUrl: process.env.CAPTCHA_VERIFY_URL ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  captchaSiteKey: process.env.NEXT_PUBLIC_CAPTCHA_SITE_KEY ?? process.env.CAPTCHA_SITE_KEY ?? "",
  allowedHosts: parseList(process.env.ALLOWED_SOURCE_HOSTS, [
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "www.soundcloud.com",
    "vimeo.com",
    "www.vimeo.com",
    "bandcamp.com",
    "www.bandcamp.com"
  ]),
  blockedPatterns: parseList(process.env.BLOCKED_SOURCE_PATTERNS, []),
};

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type UrlOutputFormat = (typeof URL_OUTPUT_FORMATS)[number];
export type AudioQuality = (typeof AUDIO_QUALITY)[number];
export type VideoQuality = (typeof VIDEO_QUALITY)[number];
