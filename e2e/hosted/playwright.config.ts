import { defineConfig, devices } from "@playwright/test";
const port = process.env.HOSTED_PORT ?? "7472";
export default defineConfig({
  testDir: ".", testMatch: /hosted\.spec\.ts/, timeout: 45000, expect: { timeout: 15000 }, workers: 1,
  reporter: "list",
  webServer: { command: `HOSTED_PORT=${port} bun ${import.meta.dirname}/server.ts`, url: `http://127.0.0.1:${port}/__hosted/ready`, reuseExistingServer: false, timeout: 30000 },
  use: { baseURL: `http://127.0.0.1:${port}`, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "hosted-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "hosted-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
