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
    // The `phone` project runs this in Chromium, which is fast and catches
    // logic; the `ios` project below runs the same tests in WebKit, which is
    // what catches the rest.
    defaultBrowserType: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    /*
     * No service worker during tests.
     *
     * Once one controls the page, its requests bypass `page.route` — in WebKit
     * completely — so every mocked write went to the real server instead. The
     * service worker has its own tests, which opt back in.
     */
    serviceWorkers: "block",
  },
  projects: [
    { name: "signin", testMatch: /auth\.setup\.ts/ },
    {
      name: "phone",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["signin"],
      use: { storageState: "e2e/.auth/state.json" },
    },
    /**
     * The same tests in the engine the phone actually runs.
     *
     * Added after two bugs in a row that Chromium could not see: a tap that
     * never reached an `<img>`, and an image inside a `<button>` collapsing to
     * nothing. Both were reported from a phone, which is a poor place for a
     * test suite to live.
     */
    {
      name: "ios",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["signin"],
      use: {
        ...devices["iPhone 14"],
        storageState: "e2e/.auth/state.json",
      },
    },
  ],
});
