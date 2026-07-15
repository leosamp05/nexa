import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "..", "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("deployment safety", () => {
  it("persists Redis queue data and restarts long-running services", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toContain('"--appendonly", "yes"');
    expect(compose).toContain("redisdata:/data");
    expect(compose).toContain("WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-2}");
    expect(compose.match(/restart: unless-stopped/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("enforces upload size and permits the configured Turnstile origins at Caddy", () => {
    const caddy = read("docker/caddy/Caddyfile");
    const compose = read("docker-compose.yml");
    expect(caddy).toContain("max_size 525MB");
    expect(caddy).toContain("https://challenges.cloudflare.com");
    expect(caddy).toContain("header_up X-Forwarded-For {remote_host}");
    expect(caddy).toContain("header_up X-Nexa-Proxy-Token {$TRUSTED_PROXY_TOKEN}");
    expect(compose).toContain("TRUSTED_PROXY_TOKEN: ${TRUSTED_PROXY_TOKEN:-unconfigured}");
  });

  it("does not ship known seed credentials or weak secret fallbacks", () => {
    const envExample = read(".env.example");
    const installer = read("scripts/install.sh");
    expect(envExample).not.toContain("ADMIN_PASSWORD=change-me-now");
    expect(envExample).not.toContain("ADMIN_EMAIL=admin@example.com");
    expect(installer).not.toContain("date +%s | shasum");
    expect(installer).toContain('case "${1:-}" in');
    expect(installer).toContain("--ensure-secrets)");
    expect(installer).toContain("replace-with-a-separate-long-random-secret");
    expect(installer).toContain("tr '[:upper:]' '[:lower:]'");
    expect(installer).toContain('REGISTRATION_ENABLED" "false"');
    expect(installer).toContain('configure_admin_seed "yes"');
    expect(read("scripts/seed-admin.ts")).toContain('role: "ADMIN"');
    expect(read("prisma/schema.prisma")).toContain("@default(USER)");
  });

  it("keeps Caddy opt-in and requires HTTPS for remote authenticated installs", () => {
    const compose = read("docker-compose.yml");
    const installer = read("scripts/install.sh");
    expect(compose).toContain('profiles: ["caddy"]');
    expect(installer).toContain("Authenticated remote installs require HTTPS");
  });

  it("keeps the direct Next.js port on loopback when Caddy is enabled", () => {
    const installer = read("scripts/install.sh");
    expect(installer).toContain('if [[ "$USE_CADDY" == "yes" ]]; then\n    docker_bind_ip="127.0.0.1"');
  });

  it("replaces documented secret placeholders without interactive prompts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexa-installer-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, [
      "SESSION_SECRET=replace-with-a-long-random-secret",
      "TRUSTED_PROXY_TOKEN=replace-with-a-separate-long-random-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    try {
      const result = spawnSync("bash", [path.join(root, "scripts/install.sh"), "--ensure-secrets"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NEXA_ENV_FILE: envPath },
      });
      const values = Object.fromEntries(fs.readFileSync(envPath, "utf8").trim().split("\n").map((line) => line.split("=", 2)));

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(values.SESSION_SECRET).toMatch(/^[a-f0-9]{64}$/);
      expect(values.TRUSTED_PROXY_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates private unpredictable backup files without putting DATABASE_URL in pg_dump argv", () => {
    const backup = read("scripts/backup-db.sh");
    expect(backup).toContain("umask 077");
    expect(backup).toContain("mktemp");
    expect(backup).not.toContain('pg_dump "$DATABASE_URL"');
  });
});
