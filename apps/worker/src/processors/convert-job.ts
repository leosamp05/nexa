import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { JobStatus, OutputFormat } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { convertDocument, isDocumentOutput } from "../converters/document";
import { convertMedia, isMediaOutput } from "../converters/media";
import { runCommand } from "../lib/command";
import { config } from "../lib/config";
import { removeJobDirectory, resolveInsideDataDir, sha256File, unlinkIfExists } from "../lib/files";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { startSafeEgressProxy } from "../lib/safe-egress-proxy";

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

async function probeDuration(filePath: string, signal?: AbortSignal) {
  const output = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { timeoutMs: 60000, signal });

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
  signal?: AbortSignal;
}) {
  const sourceHost = await validateSourceHost(params.sourceUrl);
  const normalizedUrl = normalizeSourceUrl(params.sourceUrl);
  if (!isMediaOutput(params.outputFormat)) {
    throw new Error("URL jobs support only media outputs");
  }
  if (isSoundCloudHost(sourceHost) && !isAudioOutput(params.outputFormat)) {
    throw new Error("SoundCloud links support audio outputs only.");
  }

  const safeProxy = await startSafeEgressProxy({ signal: params.signal });
  const baseArgs = [
    "--proxy",
    safeProxy.url,
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
    "--max-filesize",
    String(config.maxRemoteDownloadBytes),
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
    try {
      const args = [...baseArgs, "--format", formatArg];
      if (isYouTubeHost(sourceHost)) {
        args.push("--extractor-args", "youtube:player_client=android,web");
      }
      args.push(normalizedUrl);
      await runCommand("yt-dlp", args, { timeoutMs: config.jobTimeoutMs, signal: params.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();

      if (isSoundCloudHost(sourceHost) && lower.includes("requested format is not available")) {
        await runCommand("yt-dlp", [...baseArgs, "--format", "bestaudio/best", normalizedUrl], {
          timeoutMs: config.jobTimeoutMs,
          signal: params.signal,
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
  } finally {
    await safeProxy.close();
  }

  const inputPath = await findSourceFile(params.outputDir);
  const sourceBaseName = toConvertedBaseName(path.parse(inputPath).name);
  const duration = await probeDuration(inputPath, params.signal);
  if (duration && duration > config.maxDurationSeconds) {
    throw new Error(`Source duration exceeds limit: ${config.maxDurationSeconds}s`);
  }

  const converted = await convertMedia({
    inputPath,
    outputDir: params.outputDir,
    format: params.outputFormat,
    audioQuality: params.audioQuality,
    videoQuality: params.videoQuality,
    outputBaseName: sourceBaseName,
    timeoutMs: config.jobTimeoutMs,
    signal: params.signal,
  });
  return { ...converted, sourcePath: inputPath };
}

async function processUploadJob(params: {
  inputPath: string;
  outputDir: string;
  outputFormat: OutputFormat;
  audioQuality: "low" | "standard" | "high";
  videoQuality: "p720" | "p1080";
  outputBaseName: string;
  signal?: AbortSignal;
}) {
  if (isMediaOutput(params.outputFormat)) {
    const duration = await probeDuration(params.inputPath, params.signal);
    if (duration && duration > config.maxDurationSeconds) {
      throw new Error(`Source duration exceeds limit: ${config.maxDurationSeconds}s`);
    }
    return convertMedia({
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      format: params.outputFormat,
      audioQuality: params.audioQuality,
      videoQuality: params.videoQuality,
      outputBaseName: params.outputBaseName,
      timeoutMs: config.jobTimeoutMs,
      signal: params.signal,
    });
  }

  if (isDocumentOutput(params.outputFormat)) {
    return convertDocument({
      inputPath: params.inputPath,
      outputDir: params.outputDir,
      format: params.outputFormat,
      outputBaseName: params.outputBaseName,
      timeoutMs: config.jobTimeoutMs,
      signal: params.signal,
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

function isRetryableFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (["EAI_AGAIN", "ETIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EPIPE"].includes(code ?? "")) {
    return true;
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    "temporary dns",
    "temporarily unavailable",
    "connection reset",
    "connection refused",
    "network is unreachable",
    "remote end closed connection",
    "http error 429",
    "http error 500",
    "http error 502",
    "http error 503",
    "http error 504",
    "service unavailable",
    "too many requests",
  ].some((marker) => message.includes(marker));
}

async function markFailed(jobId: string, userId: string, leaseStartedAt: Date, message: string) {
  const shortMessage = normalizeFailureMessage(message);

  const changed = await prisma.job.updateMany({
    where: { id: jobId, status: JobStatus.processing, startedAt: leaseStartedAt },
    data: {
      status: JobStatus.failed,
      errorMessage: shortMessage,
      completedAt: new Date(),
      lastErrorAt: new Date(),
    },
  });
  if (changed.count !== 1) return false;

  try {
    await prisma.auditEvent.create({
      data: {
        userId,
        jobId,
        eventType: "job.failed",
        metadata: { message: shortMessage, rawMessage: message.slice(0, 5000) },
      },
    });
  } catch (error) {
    logger.error({ error, jobId }, "Failed to persist job failure audit event");
  }
  return true;
}

function sameInstant(left: Date | null | undefined, right: Date) {
  return left instanceof Date && left.getTime() === right.getTime();
}

function watchForCancellation(jobId: string, controller: AbortController) {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if (current?.status === JobStatus.canceled || current?.status === JobStatus.expired) {
        controller.abort(new Error("Job canceled"));
      }
    } catch (error) {
      logger.warn({ error, jobId }, "Failed to poll job cancellation state");
    } finally {
      checking = false;
    }
  }, 500);
  timer.unref?.();
  return () => clearInterval(timer);
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

  if (dbJob.status !== JobStatus.queued && dbJob.status !== JobStatus.processing) {
    logger.info({ jobId, status: dbJob.status }, "Skipping job that is not queued");
    return;
  }

  const leaseStartedAt = new Date();
  const claimWhere = dbJob.status === JobStatus.queued
    ? { id: dbJob.id, status: JobStatus.queued }
    : { id: dbJob.id, status: JobStatus.processing, startedAt: dbJob.startedAt ?? null };
  const claimed = await prisma.job.updateMany({
    where: claimWhere,
    data: {
      status: JobStatus.processing,
      attemptCount: attempt,
      maxAttempts,
      startedAt: leaseStartedAt,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) {
    logger.info({ jobId }, "Job claim lost to another state transition");
    return;
  }

  const jobDir = path.join(config.dataDir, "jobs", dbJob.id);
  const executionDir = path.join(jobDir, "runs", randomUUID());
  const abortController = new AbortController();
  const stopCancellationWatcher = watchForCancellation(dbJob.id, abortController);

  try {
    await fs.mkdir(executionDir, { recursive: true });
    let output: { outputPath: string; outputFilename: string; mimeType: string; sourcePath?: string };

    if (dbJob.sourceType === "url") {
      if (!dbJob.sourceUrl) throw new Error("Missing source URL");

      output = await processUrlJob({
        sourceUrl: dbJob.sourceUrl,
        outputDir: executionDir,
        outputFormat: dbJob.outputFormat,
        audioQuality: dbJob.audioQuality,
        videoQuality: dbJob.videoQuality,
        signal: abortController.signal,
      });
    } else {
      const input = dbJob.files.find((file) => file.kind === "input");
      if (!input) throw new Error("Input file missing");
      const originalName = dbJob.inputFilename ?? input.filename;
      const uploadBaseName = toConvertedBaseName(path.parse(originalName).name);

      output = await processUploadJob({
        inputPath: resolveInsideDataDir(input.path),
        outputDir: executionDir,
        outputFormat: dbJob.outputFormat,
        audioQuality: dbJob.audioQuality,
        videoQuality: dbJob.videoQuality,
        outputBaseName: uploadBaseName,
        signal: abortController.signal,
      });
    }

    const safeOutputPath = resolveInsideDataDir(output.outputPath);
    const stats = await fs.stat(safeOutputPath);
    const sha = await sha256File(safeOutputPath);

    const current = await prisma.job.findUnique({ where: { id: dbJob.id }, select: { status: true, startedAt: true } });
    if (current?.status === JobStatus.canceled) {
      await removeJobDirectory(dbJob.id);
      await prisma.fileArtifact.deleteMany({ where: { jobId: dbJob.id } });
      await prisma.auditEvent.create({
        data: {
          userId: dbJob.userId,
          jobId: dbJob.id,
          eventType: "job.canceled.during_processing",
        },
      });
      return;
    }
    if (!sameInstant(current?.startedAt, leaseStartedAt)) {
      await fs.rm(executionDir, { recursive: true, force: true });
      logger.info({ jobId: dbJob.id }, "Discarding output from a superseded worker lease");
      return;
    }

    const completedAt = new Date();
    const expiresAt = new Date(completedAt.getTime() + 24 * 60 * 60 * 1000);
    const completed = await prisma.$transaction(async (tx) => {
      const changed = await tx.job.updateMany({
        where: { id: dbJob.id, status: JobStatus.processing, startedAt: leaseStartedAt },
        data: { status: JobStatus.done, completedAt, expiresAt, errorMessage: null },
      });
      if (changed.count !== 1) return false;

      await tx.fileArtifact.deleteMany({ where: { jobId: dbJob.id, kind: "output" } });
      await tx.fileArtifact.create({
        data: {
          jobId: dbJob.id,
          kind: "output",
          path: safeOutputPath,
          filename: output.outputFilename,
          mimeType: output.mimeType,
          sizeBytes: BigInt(stats.size),
          sha256: sha,
          expiresAt,
        },
      });
      await tx.auditEvent.create({
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
      });
      return true;
    });

    if (!completed) {
      const latest = await prisma.job.findUnique({ where: { id: dbJob.id }, select: { status: true } });
      if (latest?.status === JobStatus.canceled || latest?.status === JobStatus.expired) {
        await removeJobDirectory(dbJob.id);
        await prisma.fileArtifact.deleteMany({ where: { jobId: dbJob.id } });
      } else {
        await fs.rm(executionDir, { recursive: true, force: true });
      }
      return;
    }

    if (output.sourcePath) {
      await unlinkIfExists(resolveInsideDataDir(output.sourcePath));
    }

    logger.info({ jobId: dbJob.id }, "Job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error, jobId: dbJob.id }, "Job failed");

    const current = await prisma.job.findUnique({ where: { id: dbJob.id }, select: { status: true, startedAt: true } });
    if (current?.status === JobStatus.canceled || current?.status === JobStatus.expired) {
      await removeJobDirectory(dbJob.id);
      await prisma.fileArtifact.deleteMany({ where: { jobId: dbJob.id } });
      await prisma.auditEvent.create({
        data: {
          userId: dbJob.userId,
          jobId: dbJob.id,
          eventType: "job.canceled.during_processing",
        },
      });
      return;
    }
    if (!sameInstant(current?.startedAt, leaseStartedAt)) {
      await fs.rm(executionDir, { recursive: true, force: true });
      logger.info({ jobId: dbJob.id }, "Ignoring failure from a superseded worker lease");
      return;
    }

    if (attempt < maxAttempts && isRetryableFailure(error)) {
      const shortMessage = normalizeFailureMessage(message);
      const requeued = await prisma.$transaction(async (tx) => {
        const changed = await tx.job.updateMany({
          where: { id: dbJob.id, status: JobStatus.processing, startedAt: leaseStartedAt },
          data: {
            status: JobStatus.queued,
            startedAt: null,
            completedAt: null,
            lastErrorAt: new Date(),
            errorMessage: `Retry ${attempt}/${maxAttempts}: ${shortMessage}`,
          },
        });
        if (changed.count !== 1) return false;
        await tx.auditEvent.create({
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
        });
        return true;
      });
      if (!requeued) return;
      await fs.rm(executionDir, { recursive: true, force: true });
      throw error;
    }

    const failed = await markFailed(dbJob.id, dbJob.userId, leaseStartedAt, message);
    if (failed) {
      await fs.rm(executionDir, { recursive: true, force: true });
      throw new UnrecoverableError(message);
    }
  } finally {
    stopCancellationWatcher();
  }
}

export async function runCleanupSweep() {
  const now = new Date();
  const expired = await prisma.job.findMany({
    where: {
      status: { in: [JobStatus.done, JobStatus.failed, JobStatus.canceled] },
      expiresAt: { lte: now },
    },
    take: 200,
  });

  for (const job of expired) {
    await removeJobDirectory(job.id);

    await prisma.$transaction([
      prisma.fileArtifact.deleteMany({ where: { jobId: job.id } }),
      prisma.job.updateMany({
        where: { id: job.id, status: { in: [JobStatus.done, JobStatus.failed, JobStatus.canceled] } },
        data: { status: JobStatus.expired },
      }),
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
