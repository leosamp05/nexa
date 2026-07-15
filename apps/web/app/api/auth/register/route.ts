import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireJsonRequest } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getClientIp, consumeRateLimit } from "@/lib/security";
import { hashPassword, isAuthRequired, isRegistrationEnabled, setSessionCookie } from "@/lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthRequired()) {
    return jsonError(400, "Auth disabled");
  }
  if (!isRegistrationEnabled()) {
    return jsonError(403, "Registration disabled");
  }

  const requestError = requireJsonRequest(request);
  if (requestError) return requestError;

  const ip = getClientIp(request);
  const [ipAllowed, globalAllowed] = await Promise.all([
    consumeRateLimit(`rl:register:ip:${ip}`, 8, 60),
    consumeRateLimit("rl:register:global", 50, 60),
  ]);
  if (!ipAllowed || !globalAllowed) return jsonError(429, "Too many attempts");

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) return jsonError(400, "Invalid payload");
  const normalizedEmail = payload.data.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  if (existing) {
    await prisma.auditEvent.create({
      data: {
        userId: existing.id,
        eventType: "auth.register.failed.exists",
        ip,
        metadata: { email: normalizedEmail },
      },
    });
    return jsonError(409, "Email already registered");
  }

  const passwordHash = await hashPassword(payload.data.password);
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      role: "USER",
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
