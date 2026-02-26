import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getClientIp, consumeRateLimit } from "@/lib/security";
import { isAuthRequired, setSessionCookie, verifyPassword } from "@/lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthRequired()) {
    return NextResponse.json({ ok: true, mode: "disabled" });
  }

  const ip = getClientIp(request);
  const allowed = await consumeRateLimit(`rl:login:${ip}`, 10, 60);
  if (!allowed) return jsonError(429, "Too many attempts");

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) return jsonError(400, "Invalid payload");

  const user = await prisma.user.findUnique({ where: { email: payload.data.email } });
  if (!user || !(await verifyPassword(payload.data.password, user.passwordHash))) {
    await prisma.auditEvent.create({
      data: {
        userId: user?.id,
        eventType: "auth.login.failed",
        ip,
        metadata: { email: payload.data.email },
      },
    });
    return jsonError(401, "Invalid credentials");
  }

  const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  await setSessionCookie(response, { sub: user.id, email: user.email, role: user.role });

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      eventType: "auth.login.success",
      ip,
    },
  });

  return response;
}
