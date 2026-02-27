import argon2 from "argon2";
import { jwtVerify, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { extractClientIpFromHeaderValues } from "@/lib/ip";
import { prisma } from "@/lib/prisma";

const COOKIE_NAME = "cv_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  sub: string;
  email: string;
  role: string;
};

function parseBool(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function isAuthRequired() {
  return parseBool(process.env.AUTH_REQUIRED, false);
}

async function getOrCreateBypassUser() {
  const requestHeaders = headers();
  const ip = extractClientIpFromHeaderValues({
    forwarded: requestHeaders.get("x-forwarded-for"),
    cfConnectingIp: requestHeaders.get("cf-connecting-ip"),
    realIp: requestHeaders.get("x-real-ip"),
  });
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 24);
  const email = `ip-${ipHash}@nexa.local`;

  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash: "auth-disabled",
      role: "ADMIN",
    },
    select: {
      id: true,
      email: true,
      role: true,
    },
  });
}

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET missing");
  return new TextEncoder().encode(secret);
}

export async function verifyPassword(plain: string, hash: string) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function hashPassword(plain: string) {
  return argon2.hash(plain);
}

export async function createSessionToken(payload: SessionPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function setSessionCookie(response: NextResponse, payload: SessionPayload) {
  if (!isAuthRequired()) return;
  const token = await createSessionToken(payload);

  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse) {
  if (!isAuthRequired()) return;
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    maxAge: 0,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export async function getCurrentSession() {
  // Mark auth consumers as dynamic in Next.js.
  const jar = cookies();

  if (!isAuthRequired()) {
    const user = await getOrCreateBypassUser();
    return {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
  }

  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify<SessionPayload>(token, getSecret());
    return payload;
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  const session = await getCurrentSession();
  if (!session?.sub) return null;

  if (!isAuthRequired()) {
    return {
      id: session.sub,
      email: session.email,
      role: session.role,
    };
  }

  return prisma.user.findUnique({
    where: { id: session.sub },
    select: { id: true, email: true, role: true },
  });
}
