import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth";
import { appConfig } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { createUrlJobSchema } from "@/lib/jobs";
import { enqueueConversionJob } from "@/lib/queue";
import { consumeRateLimit, getClientIp, validateSourceUrl, verifyCaptcha } from "@/lib/security";
import { serializeJob } from "@/lib/serialize";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const ip = getClientIp(request);
  const ipAllowed = await consumeRateLimit(`rl:url:ip:${ip}`);
  const userAllowed = await consumeRateLimit(`rl:url:user:${user.id}`, 20, 60);
  if (!ipAllowed || !userAllowed) return jsonError(429, "Rate limit exceeded");

  const payload = createUrlJobSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) return jsonError(400, "Invalid payload");

  const source = await validateSourceUrl(payload.data.url);
  if (!source.valid) return jsonError(400, source.reason);

  const captchaOk = await verifyCaptcha(payload.data.captchaToken, ip);
  if (!captchaOk) return jsonError(400, "Captcha failed");

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const dbJob = await prisma.job.create({
    data: {
      userId: user.id,
      sourceType: "url",
      sourceUrl: payload.data.url,
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
      eventType: "job.url.submitted",
      ip,
      metadata: {
        sourceHost: source.host,
        outputFormat: payload.data.outputFormat,
        purpose: "personal",
      },
    },
  });

  return NextResponse.json({ job: serializeJob(dbJob) }, { status: 201 });
}
