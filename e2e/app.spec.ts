import { expect, test } from "@playwright/test";

/**
 * The things that make it an app rather than a page: the manifest, the worker,
 * touch targets, and what happens when the session runs out.
 */

test.describe("installed app", () => {
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
    await page.goto("/");
    await expect
      .poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
        timeout: 20_000,
      })
      .toBe(true);
  });

  test("live data is never served from the cache", async ({ page }) => {
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
    await page.goto("/");
    const touchAction = await page
      .locator(".row")
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe("manipulation");
  });

  test("chrome does not select on a long press", async ({ page }) => {
    await page.goto("/");
    const selectable = await page
      .locator(".topbar")
      .evaluate((el) => getComputedStyle(el).userSelect);
    expect(["none"]).toContain(selectable);
  });
});

test.describe("the session running out", () => {
  test("an expired cookie returns you to the passcode screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();

    // What the server does once the signed cookie is past its date.
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 401, json: { error: "unauthorized" } }),
    );
    await page.locator(".row").first().click();

    await expect(page.locator(".login")).toBeVisible({ timeout: 20_000 });
  });

  test("a wrong passcode says so and lets you try again", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/");
    await expect(page.locator(".login")).toBeVisible();

    await page.locator(".login input").fill("0000");
    await page.getByRole("button", { name: "Unlock" }).click();

    await expect(page.locator(".login__error")).toBeVisible();
    await expect(page.locator(".login input")).toBeEditable();
  });
});
