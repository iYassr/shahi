import { defineConfig, devices } from "@playwright/test";

/**
 * Two suites, with different jobs.
 *
 * **The scenario suite** (`phone`, `ios`) runs against a stub server that
 * speaks the same contract with none of the consequences. That is what makes it
 * deterministic — the top row does not change while you assert on it — and what
 * makes situations testable at all: a blocked agent, no agents, twenty-eight
 * agents, a transcript with one of every block kind. It is also what stops a
 * test reaching a real session, which happened once and must not again.
 *
 * **The live suite** (`live`) is a handful of read-only checks against the real
 * server, which is the only thing that can catch the contract drifting apart
 * from the stub. It needs `SHAHI_URL` and `SHAHI_PASSCODE`.
 *
 *   bun run test:e2e                    # both engines, against the stub
 *   bun run test:e2e --project=ios      # WebKit only, which is what the phone runs
 *   SHAHI_URL=… SHAHI_PASSCODE=… bun run test:e2e --project=live
 */

const STUB = `http://127.0.0.1:${process.env.STUB_PORT ?? 7272}`;

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],

  // Started for the run and shut down after it, unless one is already up.
  webServer: {
    // Resolved from this file rather than the working directory, so the suite
    // runs the same from the repo root or from `e2e/`.
    command: `PORT=${process.env.STUB_PORT ?? 7272} bun run ${import.meta.dirname}/stub/server.ts`,
    url: `${STUB}/__stub/writes`,
    reuseExistingServer: true,
    timeout: 30_000,
  },

  use: {
    baseURL: STUB,
    ...devices["iPhone 14"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    /*
     * No service worker during tests.
     *
     * Once one controls the page its requests bypass `page.route`, in WebKit
     * entirely — which is how mocked writes ended up in a live session. The
     * worker has its own tests, which opt back in.
     */
    serviceWorkers: "block",
  },

  projects: [
    { name: "signin", testMatch: /auth\.setup\.ts/, use: { defaultBrowserType: "chromium" } },
    {
      name: "phone",
      testIgnore: /(?:live|hosted)\//,
      dependencies: ["signin"],
      use: { defaultBrowserType: "chromium", storageState: "e2e/.auth/state.json" },
    },
    /**
     * The same tests in the engine the phone actually runs.
     *
     * Added after two bugs in a row Chromium could not see: a tap that never
     * reached an `<img>`, and an image inside a `<button>` collapsing to
     * nothing. It then immediately found a third — the app was a blank page in
     * a Safari tab.
     */
    {
      name: "ios",
      testIgnore: /(?:live|hosted)\//,
      dependencies: ["signin"],
      use: { ...devices["iPhone 14"], storageState: "e2e/.auth/state.json" },
    },
    {
      name: "live",
      testMatch: /live\/.*\.spec\.ts/,
      use: { baseURL: process.env.SHAHI_URL ?? STUB, ...devices["iPhone 14"] },
    },
  ],
});
