import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

const MIN_PROXY_TOKEN_LENGTH = 32;

function proxyTokenMatches(received: string | null | undefined, expected: string | undefined) {
  if (!received || !expected || expected.length < MIN_PROXY_TOKEN_LENGTH) return false;

  const receivedDigest = createHash("sha256").update(received).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function normalizeMappedIpv4(raw: string) {
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

function normalizeIpToken(raw: string) {
  let value = raw.trim();
  if (value.length === 0) return "unknown";

  if (value.startsWith("\"") && value.endsWith("\"") && value.length > 1) {
    value = value.slice(1, -1).trim();
  }

  // Forwarded header variant: for=1.2.3.4
  if (value.toLowerCase().startsWith("for=")) {
    value = value.slice(4).trim();
  }

  // Bracketed IPv6 with optional port: [::1]:443
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 1) {
      value = value.slice(1, end);
    }
  }

  // IPv4 with port: 1.2.3.4:5678
  if (!value.includes("::")) {
    const idx = value.lastIndexOf(":");
    if (idx > 0) {
      const maybeIp = value.slice(0, idx);
      const maybePort = value.slice(idx + 1);
      if (net.isIPv4(maybeIp) && /^[0-9]+$/.test(maybePort)) {
        value = maybeIp;
      }
    }
  }

  return normalizeMappedIpv4(value.toLowerCase());
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateOrLocalIp(raw: string) {
  const ip = normalizeIpToken(raw);

  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb")
    );
  }

  return true;
}

export function extractClientIpFromHeaderValues(values: {
  forwarded?: string | null;
  cfConnectingIp?: string | null;
  realIp?: string | null;
  proxyToken?: string | null;
}, expectedProxyToken = process.env.TRUSTED_PROXY_TOKEN) {
  // Next.js does not expose the peer socket address to route handlers. Only a
  // reverse proxy that knows the shared token may supply client-IP headers;
  // direct requests use one stable, non-spoofable bucket instead.
  if (!proxyTokenMatches(values.proxyToken, expectedProxyToken)) return "direct";

  const forwardedValues = values.forwarded?.split(",").map((value) => value.trim()).filter(Boolean);
  const forwarded = forwardedValues?.at(-1);
  const candidate = forwarded || values.cfConnectingIp || values.realIp || "direct";
  return normalizeIpToken(candidate);
}

export function formatClientIpForUi(rawIp: string) {
  const normalized = normalizeIpToken(rawIp);
  if (normalized === "unknown") return "unknown";
  return isPrivateOrLocalIp(normalized) ? "private" : normalized;
}
