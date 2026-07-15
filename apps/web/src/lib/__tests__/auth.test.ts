import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { createSessionToken, isAuthRequired, isRegistrationEnabled } from "@/lib/auth";

const original = process.env.AUTH_REQUIRED;
const originalSecret = process.env.SESSION_SECRET;
const originalRegistration = process.env.REGISTRATION_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = original;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  if (originalRegistration === undefined) delete process.env.REGISTRATION_ENABLED;
  else process.env.REGISTRATION_ENABLED = originalRegistration;
});

describe("authentication configuration", () => {
  it("fails closed for an invalid explicit AUTH_REQUIRED value", () => {
    process.env.AUTH_REQUIRED = "treu";
    expect(() => isAuthRequired()).toThrow("AUTH_REQUIRED");
  });

  it.each(["1", "true", "yes", "on"])("accepts enabled value %s", (value) => {
    process.env.AUTH_REQUIRED = value;
    expect(isAuthRequired()).toBe(true);
  });

  it.each(["0", "false", "no", "off"])("accepts disabled value %s", (value) => {
    process.env.AUTH_REQUIRED = value;
    expect(isAuthRequired()).toBe(false);
  });

  it("rejects the documented placeholder session secret", async () => {
    process.env.SESSION_SECRET = "replace-with-a-long-random-secret";
    await expect(createSessionToken({ sub: "user-1", email: "a@example.com", role: "ADMIN" })).rejects.toThrow("SESSION_SECRET");
  });

  it("keeps public registration disabled unless explicitly enabled", () => {
    delete process.env.REGISTRATION_ENABLED;
    expect(isRegistrationEnabled()).toBe(false);
    process.env.REGISTRATION_ENABLED = "true";
    expect(isRegistrationEnabled()).toBe(true);
  });
});
