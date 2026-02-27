import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { JobStatus, OutputFormat } from "@prisma/client";
import { convertDocument, isDocumentOutput } from "../converters/document";
import { convertMedia, isMediaOutput } from "../converters/media";
import { runCommand } from "../lib/command";
import { config } from "../lib/config";
import { resolveInsideDataDir, sha256File, unlinkIfExists } from "../lib/files";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";

const AUDIO_OUTPUTS: OutputFormat[] = ["mp3", "aac", "ogg", "wav"];

function isAudioOutput(format: OutputFormat) {
  return AUDIO_OUTPUTS.includes(format);
}

function isYouTubeHost(host: string) {
  return host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "youtu.be" || host.endsWith(".youtu.be");
}

function isSoundCloudHost(host: string) {
  return host === "soundcloud.com" || host === "www.soundcloud.com" || host.endsWith(".soundcloud.com");
}

function isSoundCloudShortHost(host: string) {
  return host === "on.soundcloud.com" || host.endsWith(".on.soundcloud.com");
}

function normalizeIp(raw: string) {
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrLocalIp(raw: string) {
  const ip = normalizeIp(raw.toLowerCase());

  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb")
    );
  }

  return true;
}

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

async function ensureHostResolvesToPublicIps(host: string) {
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

async function resolveSoundCloudShortUrl(sourceUrl: string) {
  const parsed = new URL(sourceUrl);
  const host = parsed.hostname.toLowerCase();
  if (!isSoundCloudShortHost(host)) return sourceUrl;

  // Some SoundCloud short links do not redirect properly with fetch GET.
  const tryFetchResolve = async (method: "HEAD" | "GET") => {
    const response = await fetch(sourceUrl, {
      method,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    return response.url || sourceUrl;
  };

  try {
    const headResolved = await tryFetchResolve("HEAD");
    if (headResolved !== sourceUrl) {
      return headResolved;
    }
  } catch {
    // Try next strategy.
  }

  try {
    const getResolved = await tryFetchResolve("GET");
    if (getResolved !== sourceUrl) {
      return getResolved;
    }
  } catch {
    // Try curl fallback.
  }

  try {
    const effectiveUrl = (await runCommand(
      "curl",
      ["-sSIL", "--max-redirs", "5", "-o", "/dev/null", "-w", "%{url_effective}", sourceUrl],
      { timeoutMs: 15000 },
    )).trim();

    if (effectiveUrl && effectiveUrl !== sourceUrl) {
      return effectiveUrl;
    }
  } catch {
    // Fall through to original URL; downstream handling will produce a clear error if needed.
  }

  return sourceUrl;
}

async function validateSourceHost(sourceUrl: string) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Source URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Source URL credentials are not allowed");
  }
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new Error("Source URL port is not allowed");
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Source host is not allowed");
  }

  const blocked = config.blockedPatterns.some((pattern) => sourceUrl.toLowerCase().includes(pattern) || host.includes(pattern));
  if (blocked) throw new Error("Source blocked by policy");

  const allowed = config.allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  if (!allowed) throw new Error("Source host is not allowed");

  await ensureHostResolvesToPublicIps(host);
  return host;
}

function sanitizeBaseName(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.slice(0, 160) || "file";
}

function toConvertedBaseName(value: string) {
  const base = sanitizeBaseName(value);
  if (base.toLowerCase().endsWith("-converted")) return base;
  return `${base}-converted`;
}

function normalizeSourceUrl(sourceUrl: string) {
  const parsed = new URL(sourceUrl);
  const host = parsed.hostname.toLowerCase();

  // Avoid playlist context for single-video URLs.
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    parsed.searchParams.delete("list");
    parsed.searchParams.delete("index");
    parsed.searchParams.delete("pp");
    return parsed.toString();
  }

  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v");
      const t = parsed.searchParams.get("t");
      const cleaned = new URL("https://www.youtube.com/watch");
      if (videoId) cleaned.searchParams.set("v", videoId);
      if (t) cleaned.searchParams.set("t", t);
      return cleaned.toString();
    }
  }

  return parsed.toString();
}

async function probeDuration(filePath: string) {
  const output = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { timeoutMs: 60000 });

  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds)) return null;
  return seconds;
}

async function findSourceFile(jobDir: string) {
  const entries = await fs.readdir(jobDir);
  const found = entries.find((entry) => {
    const lower = entry.toLowerCase();
    if (lower.endsWith(".part")) return false;
    if (lower.endsWith(".ytdl")) return false;
    if (lower.endsWith(".info.json")) return false;
    if (lower.endsWith(".description")) return false;
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".webp")) return false;
    return true;
  });
  if (!found) throw new Error("Downloaded source file not found");
  return path.join(jobDir, found);
}

async function processUrlJob(params: {
  sourceUrl: string;
  outputDir: string;
  outputFormat: OutputFormat;
  audioQuality: "low" | "standard" | "high";
  videoQuality: "p720" | "p1080";
}) {
  const resolvedSourceUrl = await resolveSoundCloudShortUrl(params.sourceUrl);
  const sourceHost = await validateSourceHost(resolvedSourceUrl);
  const normalizedUrl = normalizeSourceUrl(resolvedSourceUrl);
  if (!isMediaOutput(params.outputFormat)) {
    throw new Error("URL jobs support only media outputs");
  }
  if (isSoundCloudHost(sourceHost) && !isAudioOutput(params.outputFormat)) {
    throw new Error("SoundCloud links support audio outputs only.");
  }

  const baseArgs = [
    "--no-playlist",
    "--playlist-items",
    "1",
    "--restrict-filenames",
    "--no-progress",
    "--concurrent-fragments",
    "8",
    "--extractor-retries",
    "3",
    "--socket-timeout",
    "15",
    "--embed-metadata",
    "-o",
    path.join(params.outputDir, "%(title).180B.%(ext)s"),
  ];

  const formatArg = isSoundCloudHost(sourceHost)
    ? "bestaudio/best"
    : isAudioOutput(params.outputFormat)
      ? "bestaudio/best"
      : "bestvideo*+bestaudio/best";

  try {
    const args = [...baseArgs, "--format", formatArg];
    if (isYouTubeHost(sourceHost)) {
      args.push("--extractor-args", "youtube:player_client=android,web");
    }
    args.push(normalizedUrl);
    await runCommand("yt-dlp", args, { timeoutMs: config.jobTimeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    if (isSoundCloudHost(sourceHost) && lower.includes("requested format is not available")) {
      await runCommand("yt-dlp", [...baseArgs, "--format", "bestaudio/best", normalizedUrl], {
        timeoutMs: config.jobTimeoutMs,
      });
    } else if (message.includes("Precondition check failed") || message.includes("Signature extraction failed")) {
      throw new Error(
        "YouTube extraction failed (yt-dlp). Rebuild worker image to latest yt-dlp and retry."
      );
    } else if (isSoundCloudHost(sourceHost) && lower.includes("unable to download")) {
      throw new Error("SoundCloud extraction failed. Verify the link is public and retry.");
    } else {
      throw error;
    }
  }

  const inputPath = await findSourceFile(params.outputDir);
  const sourceBaseName = toConvertedBaseName(path.parse(inputPath).name);
  const duration = await probeDuration(inputPath);
  if (duration && duration > config.maxDurationSeconds) {
    throw new Error(`Source duration exceeds limit: ${config.maxDurationSeconds}s`);
  }

  return convertMedia({
    inputPath,
    outputDir: params.outputDir,
    format: params.outputFormat,
    audioQuality: params.audioQuality,
    videoQuality: params.videoQuality,
    outputBaseName: sourceBaseName,
    timeoutMs: config.jobTimeoutMs,
  });
}

async function processUploadJob(params: {
  inputPath: string;
  outputDir: string;
  outputFormat: OutputFormat;
  audioQuality: "low" | "standard" | "high";
  videoQuality: "p720" | "p1080";
  outputBaseName: string;
}) {
  if (isMediaOutput(params.outputFormat)) {
    return convertMedia({
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      format: params.outputFormat,
      audioQuality: params.audioQuality,
      videoQuality: params.videoQuality,
      outputBaseName: params.outputBaseName,
      timeoutMs: config.jobTimeoutMs,
    });
  }

  if (isDocumentOutput(params.outputFormat)) {
    return convertDocument({
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      format: params.outputFormat,
      outputBaseName: params.outputBaseName,
      timeoutMs: config.jobTimeoutMs,
    });
  }

  throw new Error(`Unsupported output format ${params.outputFormat}`);
}

function normalizeFailureMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("source duration exceeds limit")) {
    return rawMessage;
  }

  if (
    message.includes("command failed: ffmpeg") ||
    message.includes("command failed: soffice") ||
    message.includes("enoent: no such file or directory, stat") ||
    message.includes("unsupported output format") ||
    message.includes("invalid data found when processing input") ||
    message.includes("failed to read frame size") ||
    message.includes("conversion is not possible with the requested output format")
  ) {
    return "Conversion is not possible with the requested output format.";
  }

  return rawMessage.slice(0, 1200);
}

async function markFailed(jobId: string, userId: string, message: string) {
  const shortMessage = normalizeFailureMessage(message);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.failed,
      errorMessage: shortMessage,
      completedAt: new Date(),
      lastErrorAt: new Date(),
    },
  });

  await prisma.auditEvent.create({
    data: {
      userId,
      jobId,
      eventType: "job.failed",
      metadata: { message: shortMessage, rawMessage: message.slice(0, 5000) },
    },
  });
}

export async function processConversionJob(jobId: string, attemptContext?: { attempt: number; maxAttempts: number }) {
  const attempt = attemptContext?.attempt ?? 1;
  const maxAttempts = attemptContext?.maxAttempts ?? config.queueAttempts;

  const dbJob = await prisma.job.findUnique({
    where: { id: jobId },
    include: { files: true },
  });

  if (!dbJob) {
    logger.warn({ jobId }, "Job not found");
    return;
  }

  if (dbJob.status === JobStatus.canceled) {
    logger.info({ jobId }, "Skipping canceled job");
    return;
  }

  const jobDir = path.join(config.dataDir, "jobs", dbJob.id);
  await fs.mkdir(jobDir, { recursive: true });

  await prisma.job.update({
    where: { id: dbJob.id },
    data: {
      status: JobStatus.processing,
      attemptCount: attempt,
      maxAttempts,
      startedAt: new Date(),
      errorMessage: null,
    },
  });

  try {
    let output: { outputPath: string; outputFilename: string; mimeType: string };

    if (dbJob.sourceType === "url") {
      if (!dbJob.sourceUrl) throw new Error("Missing source URL");

      output = await processUrlJob({
        sourceUrl: dbJob.sourceUrl,
        outputDir: jobDir,
        outputFormat: dbJob.outputFormat,
        audioQuality: dbJob.audioQuality,
        videoQuality: dbJob.videoQuality,
      });
    } else {
      const input = dbJob.files.find((file) => file.kind === "input");
      if (!input) throw new Error("Input file missing");
      const originalName = dbJob.inputFilename ?? input.filename;
      const uploadBaseName = toConvertedBaseName(path.parse(originalName).name);

      output = await processUploadJob({
        inputPath: resolveInsideDataDir(input.path),
        outputDir: jobDir,
        outputFormat: dbJob.outputFormat,
        audioQuality: dbJob.audioQuality,
        videoQuality: dbJob.videoQuality,
        outputBaseName: uploadBaseName,
      });
    }

    const safeOutputPath = resolveInsideDataDir(output.outputPath);
    const stats = await fs.stat(safeOutputPath);
    const sha = await sha256File(safeOutputPath);

    const current = await prisma.job.findUnique({ where: { id: dbJob.id }, select: { status: true } });
    if (current?.status === JobStatus.canceled) {
      await unlinkIfExists(safeOutputPath);
      await prisma.auditEvent.create({
        data: {
          userId: dbJob.userId,
          jobId: dbJob.id,
          eventType: "job.canceled.during_processing",
        },
      });
      return;
    }

    await prisma.$transaction([
      prisma.fileArtifact.deleteMany({ where: { jobId: dbJob.id, kind: "output" } }),
      prisma.fileArtifact.create({
        data: {
          jobId: dbJob.id,
          kind: "output",
          path: safeOutputPath,
          filename: output.outputFilename,
          mimeType: output.mimeType,
          sizeBytes: BigInt(stats.size),
          sha256: sha,
          expiresAt: dbJob.expiresAt,
        },
      }),
      prisma.job.update({
        where: { id: dbJob.id },
        data: { status: JobStatus.done, completedAt: new Date(), errorMessage: null },
      }),
      prisma.auditEvent.create({
        data: {
          userId: dbJob.userId,
          jobId: dbJob.id,
          eventType: "job.completed",
          metadata: {
            outputFormat: dbJob.outputFormat,
            outputFilename: output.outputFilename,
            outputSize: stats.size,
          },
        },
      }),
    ]);

    logger.info({ jobId: dbJob.id }, "Job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error, jobId: dbJob.id }, "Job failed");

    if (attempt < maxAttempts) {
      const shortMessage = normalizeFailureMessage(message);
      await prisma.$transaction([
        prisma.job.update({
          where: { id: dbJob.id },
          data: {
            status: JobStatus.queued,
            startedAt: null,
            completedAt: null,
            lastErrorAt: new Date(),
            errorMessage: `Retry ${attempt}/${maxAttempts}: ${shortMessage}`,
          },
        }),
        prisma.auditEvent.create({
          data: {
            userId: dbJob.userId,
            jobId: dbJob.id,
            eventType: "job.retry.scheduled",
            metadata: {
              attempt,
              maxAttempts,
              message: shortMessage,
            },
          },
        }),
      ]);
      throw error;
    }

    await markFailed(dbJob.id, dbJob.userId, message);
    throw error;
  }
}

export async function runCleanupSweep() {
  const now = new Date();
  const expired = await prisma.job.findMany({
    where: {
      status: { not: JobStatus.expired },
      expiresAt: { lte: now },
    },
    include: { files: true },
    take: 200,
  });

  for (const job of expired) {
    for (const file of job.files) {
      await unlinkIfExists(resolveInsideDataDir(file.path));
    }

    await prisma.$transaction([
      prisma.fileArtifact.deleteMany({ where: { jobId: job.id } }),
      prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.expired } }),
      prisma.auditEvent.create({
        data: {
          userId: job.userId,
          jobId: job.id,
          eventType: "job.expired.cleanup",
        },
      }),
    ]);
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, "Cleanup done");
  }
}
