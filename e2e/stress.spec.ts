import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { isHarmless, tap } from "./touch";
import { scenario } from "./stub/control";

/**
 * The app used the way it is actually used: opened, poked at, backed out of,
 * opened again. Faults that only appear after a few minutes of that are exactly
 * the ones that read as "unstable" and never show up in a single screenshot.
 */

function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !isHarmless(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("requestfailed", (r) => {
    // Navigations away from a page cancel their own requests; that is not a
    // fault worth failing on.
    const failure = r.failure()?.errorText ?? "";
    if (!failure.includes("ABORTED")) problems.push(`${r.url()} ${failure}`);
  });
  return problems;
}

test.describe("under use", () => {
  test("survives being walked through repeatedly", async ({ page }) => {
    const problems = watch(page);
    await scenario(page, "crowded");
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();

    for (let round = 0; round < 5; round++) {
      await tap(page, page.locator(".row").nth(round));
      await expect(page).toHaveURL(/\/pane\//);
      await expect(page.locator(".detail__task")).toBeVisible();

      await page.getByRole("tab", { name: "Screen" }).click();
      await expect(page.locator(".termwrap")).toBeVisible();

      await page.goBack();
      await expect(page.locator(".topbar__title")).toHaveText("Agents");
      await expect(page.locator(".row").first()).toBeVisible();

      await page.getByRole("link", { name: /spaces/i }).click();
      await expect(page.locator(".space").first()).toBeVisible();
      await page.getByRole("link", { name: /agents/i }).click();
      await expect(page.locator(".row").first()).toBeVisible();
    }

    expect(problems).toEqual([]);
  });

  test("the terminal keeps drawing as frames arrive", async ({ page }) => {
    const problems = watch(page);
    await scenario(page, "busy");
    await page.goto("/");
    await tap(page, page.locator(".row").first());
    await page.getByRole("tab", { name: "Screen" }).click();

    const term = page.locator(".term .xterm-screen, .term canvas, .term .xterm-rows").first();
    await expect(term).toBeVisible({ timeout: 20_000 });

    // Watched panes are polled at 400ms, so this is dozens of full repaints.
    await page.waitForTimeout(12_000);
    await expect(term).toBeVisible();

    await page.getByRole("button", { name: "Full size" }).click();
    await page.getByRole("button", { name: "Fit width" }).click();
    await expect(term).toBeVisible();

    expect(problems).toEqual([]);
  });

  test("the attach sheet opens and browses the server", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await tap(page, page.locator(".row").first());
    await expect(page).toHaveURL(/\/pane\//);

    await tap(page, page.locator(".compose__attach"));
    await expect(page.locator(".sheet")).toBeVisible();
    await expect(page.locator(".dir__row, .picker__row, .sheet button").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".sheet")).toBeHidden();
  });

  test("typing in the composer does not disturb the view", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await tap(page, page.locator(".row").first());
    await expect(page).toHaveURL(/\/pane\//);

    const reader = page.locator(".reader");
    const before = await reader.evaluate((el) => el.scrollTop).catch(() => 0);

    const box = page.locator("textarea").first();
    await box.click();
    await box.type("a draft that is never sent");
    await expect(box).toHaveValue("a draft that is never sent");

    const after = await reader.evaluate((el) => el.scrollTop).catch(() => 0);
    expect(Math.abs(after - before)).toBeLessThan(120);
  });
});
