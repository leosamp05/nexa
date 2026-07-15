import { NextResponse } from "next/server";

export function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export function requireJsonRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonError(415, "Content-Type must be application/json");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return jsonError(403, "Cross-site request rejected");
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const requestHost = (request.headers.get("host") || new URL(request.url).host).trim().toLowerCase();
      if (!originHost || originHost !== requestHost) {
        return jsonError(403, "Cross-site request rejected");
      }
    } catch {
      return jsonError(403, "Cross-site request rejected");
    }
  }

  return null;
}
