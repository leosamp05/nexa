import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { removeQueuedJob } from "@/lib/queue";

type Context = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

export async function POST(_request: NextRequest, context: Context) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");
  const { id } = await context.params;

  const dbJob = await prisma.job.findFirst({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!dbJob) return jsonError(404, "Job not found");
  if (dbJob.status !== "queued" && dbJob.status !== "processing") {
    return jsonError(409, "Job cannot be canceled");
  }

  const changed = await prisma.job.updateMany({
    where: {
      id: dbJob.id,
      userId: user.id,
      status: { in: ["queued", "processing"] },
    },
    data: {
      status: "canceled",
      canceledAt: new Date(),
      errorMessage: "Canceled by user",
    },
  });
  if (changed.count !== 1) return jsonError(409, "Job cannot be canceled");

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
