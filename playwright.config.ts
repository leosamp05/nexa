import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3010",
  },
  webServer: {
    command: "npm run dev -w @convertitore/web -- --hostname 127.0.0.1 --port 3010",
    port: 3010,
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
