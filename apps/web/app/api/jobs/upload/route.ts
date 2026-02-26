import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "mime-types";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { createUploadJobSchema, inferMimeFromFilename, isUploadConversionSupported } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { enqueueConversionJob } from "@/lib/queue";
import { serializeJob } from "@/lib/serialize";
import { consumeRateLimit, getClientIp } from "@/lib/security";
import { ensureJobDir, sanitizeFilename, sha256Buffer } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const ip = getClientIp(request);
  const ipAllowed = await consumeRateLimit(`rl:upload:ip:${ip}`);
  const userAllowed = await consumeRateLimit(`rl:upload:user:${user.id}`, 20, 60);
  if (!ipAllowed || !userAllowed) return jsonError(429, "Rate limit exceeded");

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError(400, "File required");

  if (file.size > appConfig.maxUploadBytes) {
    return jsonError(400, `File exceeds max size ${appConfig.maxUploadBytes}`);
  }

  const payload = createUploadJobSchema.safeParse({
    outputFormat: String(form.get("outputFormat") ?? ""),
    audioQuality: String(form.get("audioQuality") ?? "standard"),
    videoQuality: String(form.get("videoQuality") ?? "p720"),
  });

  if (!payload.success) return jsonError(400, "Invalid payload");

  const mime = String(file.type || lookup(file.name) || inferMimeFromFilename(file.name)).toLowerCase();
  const compatibility = isUploadConversionSupported(mime, payload.data.outputFormat);
  if (!compatibility.ok) return jsonError(400, compatibility.reason);

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const safeName = sanitizeFilename(file.name);

  const dbJob = await prisma.job.create({
    data: {
      userId: user.id,
      sourceType: "upload",
      inputFilename: safeName,
      outputFormat: payload.data.outputFormat,
      purpose: "personal",
      hasRights: false,
      audioQuality: payload.data.audioQuality,
      videoQuality: payload.data.videoQuality,
      expiresAt,
    },
    include: { files: true },
  });

  const jobDir = await ensureJobDir(dbJob.id);
  const extension = path.extname(safeName);
  const inputPath = path.join(jobDir, `input${extension}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(inputPath, buffer);

  await prisma.fileArtifact.create({
    data: {
      jobId: dbJob.id,
      kind: "input",
      path: inputPath,
      filename: safeName,
      mimeType: String(mime),
      sizeBytes: BigInt(file.size),
      sha256: await sha256Buffer(buffer),
      expiresAt,
    },
  });

  try {
    const queueJob = await enqueueConversionJob(dbJob.id);
    await prisma.job.update({
      where: { id: dbJob.id },
      data: { queueJobId: String(queueJob.id) },
    });
  } catch {
    await prisma.job.update({
      where: { id: dbJob.id },
      data: { status: "failed", errorMessage: "Queue unavailable" },
    });
    return jsonError(500, "Queue unavailable");
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
  });

  return NextResponse.json({ job: serializeJob(dbJob) }, { status: 201 });
}
