import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";

/**
 * A fuse, after a test suite typed into somebody's live agents.
 *
 * The write tests mocked `/api/rpc` with `page.route`, and in Chromium that
 * worked. In WebKit it did not: once a service worker controls the page its
 * requests bypass page-level interception entirely, so every "mocked" send went
 * straight to herdr — real text, and the whole key bar including Ctrl-C, into
 * whichever agent happened to be top of the list.
 *
 * The suite now runs against a stub that records writes instead of performing
 * them, so a write reaching *it* is correct and expected. This makes sure a
 * write never reaches anything else: any that leaves for another host is
 * aborted and fails the test, whatever a spec forgot to mock.
 */

/** Requests that change something on the far side. */
const WRITES = /\/api\//;

const FALLBACK_URL = "http://127.0.0.1:7272";

/**
 * Why the stub is checked for a pulse around every test.
 *
 * A review run produced 73 passes, one dashboard failure, and then 78
 * connection errors — because the stub server had died partway through and
 * Playwright does not notice. Read from the top that looks like the app falling
 * apart, and the one interesting failure (a scroll position that moved) is
 * indistinguishable from the 78 that mean nothing. It took longer to work out
 * that the server had gone than it would have taken to fix a real bug.
 *
 * So: probe before each test, and again after any test that failed. The first
 * test to find it gone fails naming the cause, the rest are skipped rather than
 * failed — they were never run, and reporting 78 regressions that did not
 * happen is the thing this is here to stop.
 */
async function unreachable(url: string): Promise<string | null> {
  try {
    const response = await fetch(new URL("/api/auth/status", url), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? null : `answered ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Written once the server stops answering, so the rest of the run stops
 * guessing. A file and not a variable: Playwright replaces the worker process
 * after a failing test, and module scope goes with it. `global-setup.ts`
 * removes this at the start of every run.
 */
export const SERVER_GONE = join(import.meta.dirname, ".server-gone");

function serverGone(): string | null {
  try {
    return readFileSync(SERVER_GONE, "utf8");
  } catch {
    return null;
  }
}

export const test = base.extend<{ serverAlive: void; noStrayWrites: void }>({
  serverAlive: [
    async ({ baseURL }, use, testInfo) => {
      const url = baseURL ?? FALLBACK_URL;

      const already = serverGone();
      if (already) {
        testInfo.skip(true, `the test server is not answering (${already})`);
        return;
      }

      const before = await unreachable(url);
      if (before) {
        writeFileSync(SERVER_GONE, before);
        throw new Error(
          `The test server at ${url} is not answering (${before}). ` +
            `Nothing after this ran against anything, so treat every later result as absent, not as a regression.`,
        );
      }

      await use();

      // A test that failed while the server was dying reports whatever the app
      // did as it lost its backend — a stale list, a scroll that did not move.
      // Say so here rather than leaving a plausible-looking regression behind.
      if (testInfo.errors.length > 0) {
        const after = await unreachable(url);
        if (after) {
          writeFileSync(SERVER_GONE, after);
          throw new Error(
            `The test server stopped answering during this test (${after}). ` +
              `The failure above is most likely a consequence of that, not a bug in the app.`,
          );
        }
      }
    },
    { auto: true },
  ],
  noStrayWrites: [
    async ({ context, baseURL }, use) => {
      const escaped: string[] = [];
      const safe = new URL(baseURL ?? "http://127.0.0.1:7272").host;

      await context.route(WRITES, async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) { await route.continue(); return; }

        // The stub is the intended destination: it records writes rather than
        // performing them, which is the whole point of running against it.
        if (target.host === safe) {
          await route.continue();
          return;
        }

        escaped.push(`${request.method()} ${target.href}`);
        await route.abort();
      });

      await use();

      expect(
        escaped,
        "a write left for somewhere that is not the stub — that is how a test ended up typing into a live agent",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
