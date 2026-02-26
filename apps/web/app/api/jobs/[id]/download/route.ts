import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { resolveInsideDataDir } from "@/lib/storage";

type Context = { params: { id: string } };

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: Context) {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Unauthorized");

  const dbJob = await prisma.job.findFirst({
    where: {
      id: context.params.id,
      userId: user.id,
    },
    include: { files: true },
  });

  if (!dbJob) return jsonError(404, "Job not found");
  if (dbJob.status !== "done") return jsonError(409, "Job not ready");
  if (dbJob.expiresAt.getTime() < Date.now()) return jsonError(410, "File expired");

  const output = dbJob.files.find((file) => file.kind === "output");
  if (!output) return jsonError(404, "Output not found");

  const buffer = await fs.readFile(resolveInsideDataDir(output.path));

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      jobId: dbJob.id,
      eventType: "job.downloaded",
      metadata: {
        filename: output.filename,
      },
    },
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": output.mimeType,
      "Content-Disposition": `attachment; filename="${output.filename}"`,
      "Content-Length": output.sizeBytes.toString(),
    },
  });
}
