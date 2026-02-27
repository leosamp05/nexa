import { NextResponse } from "next/server";
import { JobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getQueueStats } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function metricLine(name: string, value: number, labels?: Record<string, string>) {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${value}`;
  }

  const serialized = Object.entries(labels)
    .map(([key, rawValue]) => `${key}="${rawValue.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`)
    .join(",");
  return `${name}{${serialized}} ${value}`;
}

export async function GET() {
  const statuses: JobStatus[] = ["queued", "processing", "done", "failed", "expired", "canceled"];
  const grouped = await prisma.job.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  const statusCounts = new Map<JobStatus, number>(grouped.map((row) => [row.status, row._count._all]));
  const durationRows = await prisma.job.findMany({
    where: {
      status: "done",
      startedAt: { not: null },
      completedAt: { not: null },
    },
    select: {
      startedAt: true,
      completedAt: true,
    },
    orderBy: { completedAt: "desc" },
    take: 1000,
  });

  let averageDurationSec = 0;
  if (durationRows.length > 0) {
    const totalMs = durationRows.reduce((acc, row) => acc + (row.completedAt!.getTime() - row.startedAt!.getTime()), 0);
    averageDurationSec = totalMs / durationRows.length / 1000;
  }

  const queueStats = await getQueueStats().catch(() => null);

  const lines: string[] = [
    "# HELP nexa_uptime_seconds Process uptime in seconds",
    "# TYPE nexa_uptime_seconds gauge",
    metricLine("nexa_uptime_seconds", Math.round(process.uptime())),
    "# HELP nexa_jobs_total Jobs by status",
    "# TYPE nexa_jobs_total gauge",
  ];

  for (const status of statuses) {
    lines.push(metricLine("nexa_jobs_total", statusCounts.get(status) ?? 0, { status }));
  }

  lines.push(
    "# HELP nexa_job_duration_avg_seconds Average duration of recent completed jobs",
    "# TYPE nexa_job_duration_avg_seconds gauge",
    metricLine("nexa_job_duration_avg_seconds", Number(averageDurationSec.toFixed(3)))
  );

  if (queueStats) {
    lines.push(
      "# HELP nexa_queue_jobs Queue counters from BullMQ",
      "# TYPE nexa_queue_jobs gauge",
      metricLine("nexa_queue_jobs", queueStats.waiting ?? 0, { state: "waiting" }),
      metricLine("nexa_queue_jobs", queueStats.active ?? 0, { state: "active" }),
      metricLine("nexa_queue_jobs", queueStats.completed ?? 0, { state: "completed" }),
      metricLine("nexa_queue_jobs", queueStats.failed ?? 0, { state: "failed" }),
      metricLine("nexa_queue_jobs", queueStats.delayed ?? 0, { state: "delayed" }),
      metricLine("nexa_queue_jobs", queueStats.paused ?? 0, { state: "paused" }),
    );
  }

  return new NextResponse(`${lines.join("\n")}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
