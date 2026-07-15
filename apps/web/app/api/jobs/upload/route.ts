import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "mime-types";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { createUploadJobSchema, inferMimeFromFilename, isUploadConversionSupported } from "@/lib/jobs";
import { logger } from "@/lib/logger";
import { MultipartUploadError, parseUploadMultipart, type ParsedUpload } from "@/lib/multipart";
import { prisma } from "@/lib/prisma";
import { enqueueConversionJob, removeQueuedJob } from "@/lib/queue";
import { serializeJob } from "@/lib/serialize";
import { consumeRateLimit, detectMimeFromBuffer, getClientIp, isMimeMismatch, scanUploadFile } from "@/lib/security";
import { ensureJobDir, removeJobDirectory, sanitizeFilename } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const ip = getClientIp(request);
  const ipAllowed = await consumeRateLimit(`rl:upload:ip:${ip}`);
  const userAllowed = await consumeRateLimit(`rl:upload:user:${user.id}`, 20, 60);
  if (!ipAllowed || !userAllowed) return jsonError(429, "Rate limit exceeded");

  const contentLength = Number(request.headers.get("content-length"));
  const maxRequestBytes = appConfig.maxUploadBytes + 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return jsonError(413, `Request exceeds max size ${maxRequestBytes}`);
  }

  let upload: ParsedUpload;
  try {
    upload = await parseUploadMultipart(request, {
      maxFileBytes: appConfig.maxUploadBytes,
      tempRoot: path.join(appConfig.dataDir, "incoming"),
    });
  } catch (error) {
    if (error instanceof MultipartUploadError) return jsonError(error.status, error.message);
    logger.error({ error }, "Failed to parse upload");
    return jsonError(400, "Invalid multipart upload");
  }

  try {
    const payload = createUploadJobSchema.safeParse({
      outputFormat: upload.fields.outputFormat ?? "",
      audioQuality: upload.fields.audioQuality ?? "standard",
      videoQuality: upload.fields.videoQuality ?? "p720",
    });
    if (!payload.success) return jsonError(400, "Invalid payload");

    const safeName = sanitizeFilename(upload.filename);
    const reportedMime = String(upload.reportedMime || lookup(upload.filename) || inferMimeFromFilename(upload.filename)).toLowerCase();
    const detectedMime = detectMimeFromBuffer(upload.headerSample, safeName, reportedMime);
    if (detectedMime && reportedMime && isMimeMismatch(reportedMime, detectedMime)) {
      return jsonError(400, "Detected file type does not match declared type");
    }
    const effectiveMime = (detectedMime ?? reportedMime).toLowerCase();
    const compatibility = isUploadConversionSupported(effectiveMime, payload.data.outputFormat);
    if (!compatibility.ok) return jsonError(400, compatibility.reason);

    const scan = await scanUploadFile(upload.tempPath);
    if (!scan.ok) return jsonError(400, scan.reason);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dbJob = await prisma.job.create({
      data: {
        userId: user.id,
        sourceType: "upload",
        inputFilename: safeName,
        maxAttempts: appConfig.queueAttempts,
        outputFormat: payload.data.outputFormat,
        purpose: "personal",
        hasRights: false,
        audioQuality: payload.data.audioQuality,
        videoQuality: payload.data.videoQuality,
        expiresAt,
      },
      include: { files: true },
    });

    try {
      const jobDir = await ensureJobDir(dbJob.id);
      const extension = path.extname(safeName);
      const inputPath = path.join(jobDir, `input${extension}`);
      await fs.rename(upload.tempPath, inputPath);

      await prisma.fileArtifact.create({
        data: {
          jobId: dbJob.id,
          kind: "input",
          path: inputPath,
          filename: safeName,
          mimeType: String(effectiveMime),
          sizeBytes: BigInt(upload.sizeBytes),
          sha256: upload.sha256,
          expiresAt,
        },
      });

      const queueJob = await enqueueConversionJob(dbJob.id);
      await prisma.job.update({
        where: { id: dbJob.id },
        data: { queueJobId: String(queueJob.id) },
      });
    } catch {
      await removeQueuedJob(dbJob.id).catch(() => undefined);
      await removeJobDirectory(dbJob.id).catch(() => undefined);
      await prisma.job.delete({ where: { id: dbJob.id } }).catch(() => undefined);
      return jsonError(503, "Unable to accept upload");
    }

    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        jobId: dbJob.id,
        eventType: "job.upload.submitted",
        ip,
        metadata: {
          filename: safeName,
          outputFormat: payload.data.outputFormat,
        },
      },
    }).catch((error) => {
      logger.error({ error, jobId: dbJob.id }, "Failed to persist upload submission audit event");
    });

    return NextResponse.json({ job: serializeJob(dbJob) }, { status: 201 });
  } finally {
    await fs.rm(upload.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
