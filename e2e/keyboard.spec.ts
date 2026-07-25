import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The on-screen keyboard, which is where a phone browser stops behaving like a
 * browser.
 *
 * iOS does not shrink the layout viewport when the keyboard opens — it lays the
 * keyboard over the page. `visualViewport` is the only thing that reports what
 * is actually visible, and reacting to it correctly is the difference between a
 * usable composer and one buried under the keys.
 *
 * Headless Chromium has no soft keyboard, so these tests drive the same signal
 * the real one produces: `visualViewport` shrinking, and its `resize` event.
 * The behaviour under test is the app's response to that signal, which is
 * exactly where the bugs were.
 */

/** Pretends the keyboard opened, covering `covered` pixels of the viewport. */
async function openKeyboard(page: Page, covered = 336): Promise<void> {
  await page.evaluate((height) => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - height,
    });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
    viewport.dispatchEvent(new Event("resize"));
  }, covered);
}

async function closeKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight,
    });
    viewport.dispatchEvent(new Event("resize"));
  });
}

/** What Safari's toolbars do continuously while you scroll. */
async function toolbarShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    for (const height of [60, 90, 40, 0]) {
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight - height,
      });
      viewport.dispatchEvent(new Event("resize"));
    }
  });
}

const openPane = async (page: Page) => {
  await page.goto("/");
  await page.locator(".row").first().click();
  await expect(page).toHaveURL(/\/pane\//);
  await expect(page.locator("textarea")).toBeVisible();
};

test.describe("with the keyboard open", () => {
  test("the app is pinned to what is still visible", async ({ page }) => {
    await openPane(page);
    const before = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);

    await openKeyboard(page);

    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
    const after = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);
    expect(after).toBeLessThan(before - 200);
  });

  test("the composer and key bar stay reachable", async ({ page }) => {
    await openPane(page);
    await openKeyboard(page);

    const visibleBottom = await page.evaluate(() => window.innerHeight - 336);
    for (const selector of ["textarea", ".keys", ".compose__send"]) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${selector} should be laid out`).not.toBeNull();
      expect(box!.y + box!.height, `${selector} should sit above the keyboard`).toBeLessThanOrEqual(
        visibleBottom + 1,
      );
    }
  });

  test("closing it puts everything back", async ({ page }) => {
    await openPane(page);
    const before = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);

    await openKeyboard(page);
    await closeKeyboard(page);

    await expect(page.locator("html")).not.toHaveAttribute("data-keyboard", "open");
    const after = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(after - before)).toBeLessThan(2);
  });

  /**
   * The regression that made scrolling feel broken: the app used to resize
   * itself in response to Safari's toolbars collapsing, which happens
   * throughout every flick.
   */
  test("a collapsing toolbar is not mistaken for a keyboard", async ({ page }) => {
    await openPane(page);
    const before = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);

    await toolbarShifts(page);

    await expect(page.locator("html")).not.toHaveAttribute("data-keyboard", "open");
    const after = await page.locator(".app").evaluate((el) => el.getBoundingClientRect().height);
    expect(after).toBe(before);
  });

  test("typing while it is open does not move the conversation", async ({ page }) => {
    await openPane(page);
    const reader = page.locator(".reader");
    await reader.evaluate((el) => el.scrollTo(0, Math.floor(el.scrollHeight / 3)));
    const before = await reader.evaluate((el) => el.scrollTop);

    await openKeyboard(page);
    await page.locator("textarea").fill("a message typed with the keyboard up");
    await page.waitForTimeout(3_000);

    const after = await reader.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(8);
  });

  test("the draft survives the keyboard closing and opening", async ({ page }) => {
    await openPane(page);
    await openKeyboard(page);
    await page.locator("textarea").fill("half a thought");
    await closeKeyboard(page);
    await openKeyboard(page);
    await expect(page.locator("textarea")).toHaveValue("half a thought");
  });

  test("the key bar still works while the composer has focus", async ({ page }) => {
    await openPane(page);

    const sent: unknown[] = [];
    await page.route("**/api/rpc", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { result: { type: "ok" } } });
    });

    await page.locator("textarea").click();
    await openKeyboard(page);
    await page.locator(".keys button", { hasText: "esc" }).click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ method: "pane.send_keys", params: { keys: ["Escape"] } });
  });

  test("rotating with the keyboard open keeps the composer visible", async ({ page }) => {
    await openPane(page);
    await openKeyboard(page);

    await page.setViewportSize({ width: 844, height: 390 });
    await openKeyboard(page, 200);

    const box = await page.locator("textarea").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual((await page.evaluate(() => window.innerHeight)) - 200 + 1);
  });
});
