import { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";

export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function consumeRateLimit(key: string, limit = appConfig.rateLimitMax, windowSec = appConfig.rateLimitWindowSec) {
  const redis = getRedis();
  if (!redis) return true;

  try {
    if (redis.status === "wait") {
      await redis.connect();
    }

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    return current <= limit;
  } catch (error) {
    logger.warn({ error, key }, "Rate limiter failed open");
    return true;
  }
}

export function validateSourceUrl(rawUrl: string): { valid: true; host: string } | { valid: false; reason: string } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    const blocked = appConfig.blockedPatterns.some((pattern) => rawUrl.toLowerCase().includes(pattern) || host.includes(pattern));
    if (blocked) return { valid: false, reason: "Source blocked by policy" };

    const allowed = appConfig.allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
    if (!allowed) return { valid: false, reason: "Source host is not allowed" };

    return { valid: true, host };
  } catch {
    return { valid: false, reason: "Invalid URL" };
  }
}

export async function verifyCaptcha(token: string | undefined | null, ip: string) {
  if (!appConfig.captchaEnabled) return true;
  if (!token || !appConfig.captchaSecret) return false;

  const body = new URLSearchParams();
  body.set("secret", appConfig.captchaSecret);
  body.set("response", token);
  body.set("remoteip", ip);

  try {
    const response = await fetch(appConfig.captchaVerifyUrl, {
      method: "POST",
      body,
    });

    if (!response.ok) return false;
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch (error) {
    logger.error({ error }, "Captcha verification failed");
    return false;
  }
}
