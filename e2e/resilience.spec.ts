import { expect, test, type Page } from "@playwright/test";

/**
 * What the app does when the network misbehaves, and what it costs while it
 * behaves.
 *
 * A phone on a home screen spends its life being suspended, moved between
 * networks and woken up again. Every one of these was a way the dashboard could
 * end up quietly showing hours-old agents as though they were current.
 */

const liveAgain = (page: Page) =>
  expect(page.locator(".link--live")).toBeVisible({ timeout: 40_000 });

test.describe("resilience", () => {
  test("recovers on its own after the network drops", async ({ page, context }) => {
    await page.goto("/");
    await liveAgain(page);

    await context.setOffline(true);
    await expect(page.locator(".link--lost")).toBeVisible({ timeout: 30_000 });

    await context.setOffline(false);
    await liveAgain(page);
    // And the list is still there, rather than an empty shell.
    await expect(page.locator(".row, .blocked").first()).toBeVisible();
  });

  test("reconnects immediately when the app comes back to the foreground", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await liveAgain(page);

    // Backgrounded, dropped, foregrounded — the shape of a phone being pocketed
    // on wifi and taken out on cellular.
    await context.setOffline(true);
    await expect(page.locator(".link--lost")).toBeVisible({ timeout: 30_000 });
    await context.setOffline(false);

    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await liveAgain(page);
  });

  test("does not flood the connection while sitting idle", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.goto("/");
    await expect(page.locator(".row, .blocked").first()).toBeVisible();
    requests.length = 0;

    await page.waitForTimeout(20_000);

    // The dashboard is push-fed: nothing should be polling it on a timer.
    const api = requests.filter((u) => u.includes("/api/"));
    expect(api.length).toBeLessThan(8);
  });

  test("the reader polls at its stated rate and no faster", async ({ page }) => {
    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);

    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.waitForTimeout(15_000);

    // 15s at one poll every 2.5s is six, plus a little slack for the pane
    // detail. Anything near a request per render means an effect is churning.
    const polls = requests.filter((u) => u.includes("/session?limit="));
    expect(polls.length).toBeLessThanOrEqual(9);
  });

  /** What a stale notification opens: the pane it names has since closed. */
  test("says so when a pane is gone instead of spinning", async ({ page }) => {
    await page.goto("/pane/wZ%3Ap9");
    await expect(page.getByText(/this pane is gone/i)).toBeVisible({ timeout: 20_000 });
    // And no composer aimed at nothing.
    await expect(page.locator("textarea")).toHaveCount(0);

    await page.getByRole("button", { name: /back to agents/i }).click();
    await expect(page.locator(".topbar__title")).toHaveText("Agents");
  });

  test("the terminal does not scroll into empty space when it fits", async ({ page }) => {
    await page.goto("/");
    await page.locator(".row").first().click();
    await page.getByRole("tab", { name: "Screen" }).click();
    await expect(page.locator(".term")).toBeVisible();
    await page.waitForTimeout(2_000);

    const fitted = await page.evaluate(() => {
      const wrap = document.querySelector(".termwrap")!;
      return { scrollable: wrap.scrollWidth - wrap.clientWidth };
    });
    // "Fit width" means it fits: there should be nothing to pan to.
    expect(fitted.scrollable).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "Full size" }).click();
    await page.waitForTimeout(500);
    const full = await page.evaluate(() => {
      const wrap = document.querySelector(".termwrap")!;
      return { scrollable: wrap.scrollWidth - wrap.clientWidth };
    });
    // At full size it genuinely is wider than the phone, and pans.
    expect(full.scrollable).toBeGreaterThan(50);
  });

  test("leaves nothing growing behind it", async ({ page }) => {
    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);
    await page.waitForTimeout(3_000);

    const before = await page.evaluate(() => document.querySelectorAll("*").length);
    await page.waitForTimeout(15_000);
    const after = await page.evaluate(() => document.querySelectorAll("*").length);

    // A steady conversation should not be accumulating DOM on a timer.
    expect(after - before).toBeLessThan(50);
  });
});
