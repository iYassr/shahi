import { defineConfig, devices } from "@playwright/test";
// Both fixture computers, each with its stub on the next port up; movable so
// the suite can run beside another copy of itself on a shared machine.
const port = process.env.HOSTED_PORT ?? "7472";
const second = process.env.HOSTED_SECOND_PORT ?? "7572";
export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: 0,
  testDir: ".", testMatch: /hosted\.spec\.ts/, timeout: 45000, expect: { timeout: 15000 }, workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  // SIGTERM, not Playwright's default SIGKILL, so the embedded stub removes its temp directory.
  webServer: [{ command: `HOSTED_PORT=${port} bun ${import.meta.dirname}/server.ts`, url: `http://127.0.0.1:${port}/__hosted/ready`, reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: `HOSTED_PORT=${second} HOSTED_FIXTURE_ID=second-computer bun ${import.meta.dirname}/server.ts`, url: `http://127.0.0.1:${second}/__hosted/ready`, reuseExistingServer: false, timeout: 30000, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } }],
  use: { baseURL: `http://127.0.0.1:${port}`, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "hosted-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "hosted-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
