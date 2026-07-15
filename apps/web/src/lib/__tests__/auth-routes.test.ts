import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn().mockResolvedValue(null),
  createUser: vi.fn().mockResolvedValue({ id: "user-new", email: "fresh@example.com", role: "ADMIN" }),
  consumeRateLimit: vi.fn().mockResolvedValue(true),
  verifyPassword: vi.fn().mockResolvedValue(false),
  setSessionCookie: vi.fn(),
  createAudit: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth", () => ({
  isAuthRequired: vi.fn().mockReturnValue(true),
  verifyPassword: mocks.verifyPassword,
  hashPassword: vi.fn().mockResolvedValue("hash"),
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique, create: mocks.createUser },
    auditEvent: { create: mocks.createAudit },
  },
}));
vi.mock("@/lib/security", () => ({ consumeRateLimit: mocks.consumeRateLimit, getClientIp: vi.fn().mockReturnValue("203.0.113.7") }));

import { POST as login } from "../../../app/api/auth/login/route";
import { POST as register } from "../../../app/api/auth/register/route";

describe("authentication request boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue({ id: "user-new", email: "fresh@example.com", role: "ADMIN" });
    mocks.consumeRateLimit.mockResolvedValue(true);
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.createAudit.mockResolvedValue({});
  });

  it.each([
    ["login", login, { email: "attacker@example.com", password: "Password1!" }],
    ["register", register, { email: "fresh@example.com", password: "Password1!" }],
  ])("rejects text/plain %s submissions before parsing credentials", async (_name, handler, body) => {
    const request = new Request("http://localhost/api/auth", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
    });

    const response = await handler(request as never);
    expect(response.status).toBe(415);
  });

  it.each([
    ["login", login, { email: "attacker@example.com", password: "Password1!" }],
    ["register", register, { email: "fresh@example.com", password: "Password1!" }],
  ])("rejects same-site cross-origin JSON %s submissions before rate limiting", async (_name, handler, body) => {
    const request = new Request("https://nexa.example/api/auth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "nexa.example",
        origin: "https://attacker.nexa.example",
        "sec-fetch-site": "same-site",
      },
      body: JSON.stringify(body),
    });

    const response = await handler(request as never);
    expect(response.status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it("keeps both IP and normalized-account login budgets stable", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "user-1",
      email: "mixed@example.com",
      passwordHash: "hash",
      role: "ADMIN",
    });
    mocks.verifyPassword.mockResolvedValue(true);
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ email: "Mixed@Example.COM", password: "Password1!" }),
    });

    const response = await login(request as never);

    const accountHash = createHash("sha256").update("mixed@example.com").digest("hex");
    expect(response.status).toBe(200);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("rl:login:ip:203.0.113.7", 10, 60);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("rl:login:global", 200, 60);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(`rl:login:account:${accountHash}`, 10, 60);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "mixed@example.com" } });
  });

  it("bounds aggregate registration work and stores canonical email addresses", async () => {
    const request = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ email: "Fresh@Example.COM", password: "Password1!" }),
    });

    const response = await register(request as never);

    expect(response.status).toBe(200);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("rl:register:ip:203.0.113.7", 8, 60);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("rl:register:global", 50, 60);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "fresh@example.com" }, select: { id: true } });
    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "fresh@example.com" }),
    }));
  });
});
