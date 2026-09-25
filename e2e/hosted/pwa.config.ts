import { defineConfig, devices } from "@playwright/test";

const media = "e2e/hosted/.wrangler/state";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: 0,
  testDir: ".", testMatch: /pwa\.spec\.ts/, timeout: 45000, expect: { timeout: 15000 }, workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: [
    // SIGTERM, not Playwright's default SIGKILL, so the embedded stub removes its temp directory.
    { command: `HOSTED_PORT=7472 bun ${import.meta.dirname}/server.ts`, url: "http://127.0.0.1:7472/__hosted/ready", reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    // Stand-ins for the launch video go into a local R2 of the suite's own first (seed-media.ts says why).
    { command: `bun e2e/hosted/seed-media.ts ${media} && bunx wrangler dev --config site/wrangler.toml --port 7672 --inspector-port 0 --persist-to ${media}`, cwd: new URL("../../", import.meta.url).pathname, url: "http://127.0.0.1:7672/pwa/", reuseExistingServer: false, timeout: 60000 },
  ],
  use: { baseURL: "http://127.0.0.1:7472", serviceWorkers: "allow", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "pwa-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "pwa-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
