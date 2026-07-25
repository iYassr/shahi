import { test as base, expect } from "@playwright/test";

/**
 * A fuse, after a test suite typed into somebody's live agents.
 *
 * The write tests all mock `/api/rpc` with `page.route`, and in Chromium that
 * works. In WebKit it does not: once a service worker controls the page, its
 * requests bypass page-level interception entirely, so every "mocked" send went
 * straight to herdr. A test that meant to assert what the composer *would* send
 * instead sent it — real text, and the whole key bar including Ctrl-C, into
 * whichever agent happened to be at the top of the list.
 *
 * Two changes stop that. The config blocks service workers, so interception
 * works everywhere. And this: a context-level route that catches any write that
 * got past a spec's own mock, refuses to let it out, and fails the test.
 *
 * Page routes take precedence over context routes, so a spec that mocks a write
 * still sees it. Anything that reaches here was never meant to leave.
 */

/** Requests that change something on the far side. */
const WRITES = /\/api\/(rpc|uploads|agents\/start|push\/(subscribe|test|expo))/;

export const test = base.extend<{ noStrayWrites: void }>({
  noStrayWrites: [
    async ({ context }, use) => {
      const escaped: string[] = [];

      await context.route(WRITES, async (route) => {
        const request = route.request();
        escaped.push(`${request.method()} ${new URL(request.url()).pathname}`);
        // Aborted rather than fulfilled: a test that depends on the response is
        // a test that should have mocked it.
        await route.abort();
      });

      await use();

      expect(
        escaped,
        "a write escaped this spec's mocks — in a live session that would have reached an agent",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
