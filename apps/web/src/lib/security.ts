import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { extractClientIpFromHeaderValues, isPrivateOrLocalIp } from "@/lib/ip";
import { logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";

export { isPrivateOrLocalIp } from "@/lib/ip";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDnsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ENETUNREACH";
}

type DnsAddressRecord = { address: string; family: number };

async function lookupWithRetry(host: string, attempts = 3) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await dns.lookup(host, { all: true, verbatim: true }) as DnsAddressRecord[];
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientDnsError(error)) break;
      await sleep(200 * attempt);
    }
  }

  throw lastError;
}

async function assertHostResolvesPublic(host: string) {
  let records: DnsAddressRecord[];
  try {
    records = await lookupWithRetry(host, 3);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EAI_AGAIN" || code === "ETIMEOUT") {
      throw new Error("Temporary DNS resolution error. Please retry.");
    }
    throw new Error("Source host cannot be resolved");
  }

  if (records.length === 0) {
    throw new Error("Source host cannot be resolved");
  }

  for (const record of records) {
    if (isPrivateOrLocalIp(record.address)) {
      throw new Error("Source resolves to private/internal network");
    }
  }
}

function mimeFamily(mimeType: string) {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/pdf" || mime.includes("word") || mime.includes("officedocument") || mime === "application/rtf" || mime.includes("opendocument")) {
    return "document";
  }
  return "other";
}

function looksLikeText(buffer: Buffer) {
  const sample = buffer.subarray(0, 2048);
  if (sample.length === 0) return false;

  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      printable += 1;
      continue;
    }
    if (byte >= 32 && byte <= 126) {
      printable += 1;
      continue;
    }
    if (byte === 0) return false;
  }
  return printable / sample.length > 0.85;
}

export function detectMimeFromBuffer(buffer: Buffer, filename: string) {
  if (buffer.length < 4) return null;
  const lowerName = filename.toLowerCase();

  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";

  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.length > 12 &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }

  if (buffer.length > 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }

  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    if (lowerName.endsWith(".webm")) return "video/webm";
    return "video/x-matroska";
  }

  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (lowerName.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (lowerName.endsWith(".odt")) return "application/vnd.oasis.opendocument.text";
    return "application/zip";
  }

  if (looksLikeText(buffer)) return "text/plain";
  return null;
}

export function isMimeMismatch(reportedMime: string, detectedMime: string) {
  const reported = mimeFamily(reportedMime);
  const detected = mimeFamily(detectedMime);
  if (detected === "other" || reported === "other") return false;
  return reported !== detected;
}

function runClamScan(filePath: string): Promise<"clean" | "infected"> {
  return new Promise((resolve, reject) => {
    const child = spawn("clamscan", ["--no-summary", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Antivirus scan timed out"));
    }, 30_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve("clean");
      if (code === 1) return resolve("infected");
      reject(new Error(stderr.trim() || `clamscan exited with code ${code}`));
    });
  });
}

export function getClientIp(request: NextRequest): string {
  return extractClientIpFromHeaderValues({
    forwarded: request.headers.get("x-forwarded-for"),
    cfConnectingIp: request.headers.get("cf-connecting-ip"),
    realIp: request.headers.get("x-real-ip"),
  });
}

export async function consumeRateLimit(key: string, limit = appConfig.rateLimitMax, windowSec = appConfig.rateLimitWindowSec) {
  const redis = getRedis();
  if (!redis) return true;

  try {
    if (redis.status === "wait") {
      await redis.connect();
    }

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    return current <= limit;
  } catch (error) {
    logger.warn({ error, key }, "Rate limiter failed open");
    return true;
  }
}

export async function validateSourceUrl(rawUrl: string): Promise<{ valid: true; host: string } | { valid: false; reason: string }> {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, reason: "Source URL must use http or https" };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, reason: "Source URL credentials are not allowed" };
    }
    if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
      return { valid: false, reason: "Source URL port is not allowed" };
    }
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      return { valid: false, reason: "Source host is not allowed" };
    }

    const blocked = appConfig.blockedPatterns.some((pattern) => rawUrl.toLowerCase().includes(pattern) || host.includes(pattern));
    if (blocked) return { valid: false, reason: "Source blocked by policy" };

    const allowed = appConfig.allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
    if (!allowed) return { valid: false, reason: "Source host is not allowed" };

    await assertHostResolvesPublic(host);
    return { valid: true, host };
  } catch (error) {
    if (error instanceof Error && error.message.length > 0) {
      return { valid: false, reason: error.message };
    }
    return { valid: false, reason: "Invalid URL" };
  }
}

export async function verifyCaptcha(token: string | undefined | null, ip: string) {
  if (!appConfig.captchaEnabled) return true;
  if (!token || !appConfig.captchaSecret) return false;

  const body = new URLSearchParams();
  body.set("secret", appConfig.captchaSecret);
  body.set("response", token);
  body.set("remoteip", ip);

  try {
    const response = await fetch(appConfig.captchaVerifyUrl, {
      method: "POST",
      body,
    });

    if (!response.ok) return false;
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch (error) {
    logger.error({ error }, "Captcha verification failed");
    return false;
  }
}

export async function scanUploadBuffer(buffer: Buffer, filename: string) {
  if (!appConfig.antivirusEnabled) return { ok: true as const };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexa-scan-"));
  const tempFile = path.join(dir, `${randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);

  try {
    await fs.writeFile(tempFile, buffer);
    const result = await runClamScan(tempFile);
    if (result === "infected") {
      return { ok: false as const, reason: "Malware detected in uploaded file." };
    }
    return { ok: true as const };
  } catch (error) {
    logger.error({ error }, "Antivirus scan failed");
    return { ok: false as const, reason: "Antivirus scan failed." };
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
