import { describe, expect, it } from "vitest";
import { requireJsonRequest } from "@/lib/http";

describe("JSON request boundary", () => {
  it("rejects browser requests originating from a same-site sibling origin", () => {
    const request = new Request("https://nexa.example/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "nexa.example",
        origin: "https://attacker.nexa.example",
        "sec-fetch-site": "same-site",
      },
      body: "{}",
    });

    expect(requireJsonRequest(request)?.status).toBe(403);
  });

  it("rejects an explicit origin that does not match the request host", () => {
    const request = new Request("https://nexa.example/api/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "nexa.example",
        origin: "https://evil.example",
        "sec-fetch-site": "none",
      },
      body: "{}",
    });

    expect(requireJsonRequest(request)?.status).toBe(403);
  });

  it("accepts same-origin browser JSON and non-browser JSON clients", () => {
    const browserRequest = new Request("https://nexa.example/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        host: "nexa.example",
        origin: "https://nexa.example",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    const apiRequest = new Request("https://nexa.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(requireJsonRequest(browserRequest)).toBeNull();
    expect(requireJsonRequest(apiRequest)).toBeNull();
  });
});
