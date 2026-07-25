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
const WRITES = /\/api\/(rpc|uploads|agents\/start|push\/(subscribe|test|expo))/;

export const test = base.extend<{ noStrayWrites: void }>({
  noStrayWrites: [
    async ({ context, baseURL }, use) => {
      const escaped: string[] = [];
      const safe = new URL(baseURL ?? "http://127.0.0.1:7272").host;

      await context.route(WRITES, async (route) => {
        const request = route.request();
        const target = new URL(request.url());

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
