import net from "node:net";

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
}) {
  const forwarded = values.forwarded?.split(",")[0].trim();
  const candidate = forwarded || values.cfConnectingIp || values.realIp || "unknown";
  return normalizeIpToken(candidate);
}

export function formatClientIpForUi(rawIp: string) {
  const normalized = normalizeIpToken(rawIp);
  if (normalized === "unknown") return "unknown";
  return isPrivateOrLocalIp(normalized) ? "private" : normalized;
}
