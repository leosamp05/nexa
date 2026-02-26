import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

export async function GET() {
  const checks: Record<string, "ok" | "fail"> = { db: "ok", redis: "ok" };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.db = "fail";
  }

  const redis = getRedis();
  if (redis) {
    try {
      if (redis.status === "wait") {
        await redis.connect();
      }
      await redis.ping();
    } catch {
      checks.redis = "fail";
    }
  }

  const ok = Object.values(checks).every((value) => value === "ok");
  return NextResponse.json({ status: ok ? "ok" : "degraded", checks }, { status: ok ? 200 : 503 });
}
