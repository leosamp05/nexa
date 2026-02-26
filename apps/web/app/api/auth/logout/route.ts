import { NextResponse } from "next/server";
import { clearSessionCookie, getCurrentUser, isAuthRequired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST() {
  if (!isAuthRequired()) {
    return NextResponse.json({ ok: true, mode: "disabled" });
  }

  const user = await getCurrentUser();

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);

  if (user) {
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        eventType: "auth.logout",
      },
    });
  }

  return response;
}
