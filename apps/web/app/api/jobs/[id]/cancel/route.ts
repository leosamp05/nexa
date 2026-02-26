import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { removeQueuedJob } from "@/lib/queue";

type Context = { params: { id: string } };

export const runtime = "nodejs";

export async function POST(_request: NextRequest, context: Context) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const dbJob = await prisma.job.findFirst({
    where: {
      id: context.params.id,
      userId: user.id,
    },
  });

  if (!dbJob) return jsonError(404, "Job not found");
  if (dbJob.status !== "queued" && dbJob.status !== "processing") {
    return jsonError(409, "Job cannot be canceled");
  }

  await prisma.job.update({
    where: { id: dbJob.id },
    data: {
      status: "canceled",
      canceledAt: new Date(),
      errorMessage: "Canceled by user",
    },
  });

  try {
    await removeQueuedJob(dbJob.id);
  } catch {
    // no-op
  }

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      jobId: dbJob.id,
      eventType: "job.canceled",
    },
  });

  return NextResponse.json({ ok: true });
}
