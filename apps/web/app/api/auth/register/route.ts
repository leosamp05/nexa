import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getClientIp, consumeRateLimit } from "@/lib/security";
import { hashPassword, isAuthRequired, setSessionCookie } from "@/lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthRequired()) {
    return jsonError(400, "Auth disabled");
  }

  const ip = getClientIp(request);
  const allowed = await consumeRateLimit(`rl:register:${ip}`, 8, 60);
  if (!allowed) return jsonError(429, "Too many attempts");

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) return jsonError(400, "Invalid payload");

  const existing = await prisma.user.findUnique({
    where: { email: payload.data.email },
    select: { id: true },
  });

  if (existing) {
    await prisma.auditEvent.create({
      data: {
        userId: existing.id,
        eventType: "auth.register.failed.exists",
        ip,
        metadata: { email: payload.data.email },
      },
    });
    return jsonError(409, "Email already registered");
  }

  const passwordHash = await hashPassword(payload.data.password);
  const user = await prisma.user.create({
    data: {
      email: payload.data.email,
      passwordHash,
    },
    select: {
      id: true,
      email: true,
      role: true,
    },
  });

  const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  await setSessionCookie(response, { sub: user.id, email: user.email, role: user.role });

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      eventType: "auth.register.success",
      ip,
    },
  });

  return response;
}
