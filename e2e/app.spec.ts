import { expect, test } from "./fixtures";
import { tap } from "./touch";
import { scenario } from "./stub/control";

/**
 * The things that make it an app rather than a page: the manifest, the worker,
 * touch targets, and what happens when the session runs out.
 */

test.describe("installed app", () => {
  // The only place a worker is wanted: these tests are about it.
  test.use({ serviceWorkers: "allow" });

  test("the manifest describes something installable", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);

    const manifest = await res.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.background_color).toBeTruthy();
    // iOS needs a 180px icon for the home screen, and Android a 192 and a 512.
    const sizes = (manifest.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  test("its icons are actually served", async ({ request }) => {
    for (const icon of ["/icon-180.png", "/icon-192.png", "/icon-512.png"]) {
      const res = await request.get(icon);
      expect(res.ok(), `${icon} should exist`).toBe(true);
      expect(res.headers()["content-type"]).toContain("image");
    }
  });

  test("the service worker takes control", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await expect
      .poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
        timeout: 20_000,
      })
      .toBe(true);
  });

  test("live data is never served from the cache", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await page.waitForTimeout(2_000);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });

    expect(cached.some((u) => u.startsWith("/api/"))).toBe(false);
    // But the shell is there, or none of this was worth doing.
    expect(cached).toContain("/");
    expect(cached.some((u) => u.startsWith("/assets/"))).toBe(true);
  });
});

test.describe("touch", () => {
  test("everything tappable is big enough to tap", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();

    const small = await page.evaluate(() => {
      const tooSmall: string[] = [];
      for (const el of document.querySelectorAll("button, a, [role='tab']")) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue; // hidden
        // Apple's own floor is 44×44. Height is the one that actually gets
        // missed on a phone; a wide, short row is still hard to hit.
        if (box.height < 40) tooSmall.push(`${el.className || el.tagName} ${Math.round(box.height)}px`);
      }
      return tooSmall;
    });

    expect(small).toEqual([]);
  });

  test("the double-tap zoom delay is off", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    const touchAction = await page
      .locator(".row")
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe("manipulation");
  });

  test("chrome does not select on a long press", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    // WebKit reports this under the prefix and leaves the unprefixed property
    // undefined, so asking for one of them only works in one engine.
    const selectable = await page.locator(".topbar").evaluate((el) => {
      const style = getComputedStyle(el);
      return style.userSelect || style.webkitUserSelect;
    });
    expect(selectable).toBe("none");
  });
});

test.describe("the session running out", () => {
  test("an expired cookie returns you to the passcode screen", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();

    // What the server does once the signed cookie is past its date.
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 401, json: { error: "unauthorized" } }),
    );
    await tap(page, page.locator(".row").first());

    await expect(page.locator(".login")).toBeVisible({ timeout: 20_000 });
  });

  test("a wrong passcode says so and lets you try again", async ({ page, context }) => {
    await context.clearCookies();
    await scenario(page, "busy");
    await page.goto("/");
    await expect(page.locator(".login")).toBeVisible();

    await page.locator(".login input").fill("0000");
    await page.getByRole("button", { name: "Unlock" }).click();

    await expect(page.locator(".login__error")).toBeVisible();
    await expect(page.locator(".login input")).toBeEditable();
  });
});

test.describe("when something breaks", () => {
  /**
   * The owner's complaint was "I have to refresh the page a lot". React
   * unmounts the whole tree when a render throws, so before this every such
   * fault was a blank screen with no way back — precisely the shape of that
   * complaint.
   *
   * Provoked with a transcript the reader cannot draw: a message whose blocks
   * are not an array. The app trusts the shape of what the server sends, which
   * is exactly the assumption that breaks in the field.
   */
  test("a render error offers a way out instead of a blank screen", async ({ page }) => {
    await page.route("**/api/panes/*/session*", (route) =>
      route.fulfill({
        json: {
          sessionId: "s",
          path: "/x",
          offset: 0,
          total: 1,
          messages: [{ id: "bad", role: "agent", at: 0, blocks: "not an array" }],
        },
      }),
    );

    await scenario(page, "busy");
    await page.goto("/");
    await tap(page, page.locator(".row").first());

    // Either the reader coped or the boundary caught it — but never a blank
    // page with nothing on it.
    const shown = page.locator(".reader, .boundary__what, .empty").first();
    await expect(shown).toBeVisible({ timeout: 20_000 });

    /*
     * Polled, and against the element rather than `body`.
     *
     * `body.innerText()` failed roughly one run in four in WebKit — with the
     * boundary plainly drawn in the failure screenshot, message and both
     * buttons and all. innerText is defined in terms of rendered text, so it
     * can come back empty on a layout WebKit has not settled; the page was
     * never blank. Reading the element that is already asserted visible, and
     * retrying, tests what this is actually about.
     */
    await expect
      .poll(async () => (await shown.innerText()).trim().length)
      .toBeGreaterThan(0);
  });
});
