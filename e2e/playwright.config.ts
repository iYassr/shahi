import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the running server.
 *
 * Deliberately pointed at the live instance rather than a fixture: the bugs
 * being chased here — scroll position surviving a poll, pagination surviving a
 * poll — only appear when real data is arriving on a real interval. Nothing in
 * this suite writes to an agent.
 *
 * Phone-shaped, because that is the only shape this app is used in.
 *
 *   HERDRUI_URL=http://host:7171 HERDRUI_PASSCODE=… bun run test:e2e
 */
export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.HERDRUI_URL ?? "http://127.0.0.1:7171",
    ...devices["iPhone 14"],
    // The device preset asks for WebKit; chromium is what is installed here,
    // and the viewport is what these tests care about.
    defaultBrowserType: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "signin", testMatch: /auth\.setup\.ts/ },
    {
      name: "phone",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["signin"],
      use: { storageState: "e2e/.auth/state.json" },
    },
  ],
});
