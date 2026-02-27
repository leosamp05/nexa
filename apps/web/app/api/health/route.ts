import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQueueStats } from "@/lib/queue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, "ok" | "fail"> = { db: "ok", redis: "ok", queue: "ok" };
  let queue: Awaited<ReturnType<typeof getQueueStats>> | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.db = "fail";
  }

  const redis = getRedis();
  if (!redis) {
    checks.redis = "fail";
    checks.queue = "fail";
  } else {
    try {
      if (redis.status === "wait") {
        await redis.connect();
      }
      await redis.ping();
      queue = await getQueueStats();
    } catch {
      checks.redis = "fail";
      checks.queue = "fail";
    }
  }

  const ok = Object.values(checks).every((value) => value === "ok");
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      checks,
      uptimeSec: Math.round(process.uptime()),
      queue,
    },
    { status: ok ? 200 : 503 }
  );
}
