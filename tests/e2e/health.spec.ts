import { test, expect } from "@playwright/test";

test("health endpoint responds with status payload", async ({ request }) => {
  const response = await request.get("/api/health");
  expect([200, 503]).toContain(response.status());

  const payload = (await response.json()) as {
    status: "ok" | "degraded";
    checks: Record<string, "ok" | "fail">;
  };

  expect(payload.status === "ok" || payload.status === "degraded").toBe(true);
  expect(typeof payload.checks.db).toBe("string");
});
