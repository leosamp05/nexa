import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { serializeJob } from "@/lib/serialize";
import { jobDirPath, removeDirectoryIfEmpty, removeFileIfExists, resolveInsideDataDir } from "@/lib/storage";

type Context = { params: { id: string } };

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: Context) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const job = await prisma.job.findFirst({
    where: {
      id: context.params.id,
      userId: user.id,
    },
    include: { files: true },
  });

  if (!job) return jsonError(404, "Job not found");
  return NextResponse.json({ job: serializeJob(job) });
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const job = await prisma.job.findFirst({
    where: {
      id: context.params.id,
      userId: user.id,
    },
    include: { files: true },
  });

  if (!job) return jsonError(404, "Job not found");

  for (const file of job.files) {
    await removeFileIfExists(resolveInsideDataDir(file.path));
  }
  await removeDirectoryIfEmpty(jobDirPath(job.id));

  await prisma.$transaction([
    prisma.auditEvent.create({
      data: {
        userId: user.id,
        jobId: job.id,
        eventType: "job.deleted",
      },
    }),
    prisma.job.delete({ where: { id: job.id } }),
  ]);

  return NextResponse.json({ ok: true });
}
