import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { isHarmless, tap } from "./touch";
import { scenario } from "./stub/control";

/** Anything the console reports as an error is a failure, wherever it happens. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !isHarmless(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

test.describe("dashboard", () => {
  test("lists agents and stays quiet", async ({ page }) => {
    await scenario(page, "busy");
    const problems = watchConsole(page);
    await page.goto("/");

    await expect(page.locator(".topbar__title")).toHaveText("Agents");
    await expect(page.locator(".row, .blocked").first()).toBeVisible();
    await expect(page.locator(".link--live")).toBeVisible();

    expect(problems).toEqual([]);
  });

  test("remembers how you grouped it", async ({ page }) => {
    await scenario(page, "crowded");
    await page.goto("/");
    await page.getByRole("button", { name: "Space" }).click();
    await expect(page.locator(".group__label").first()).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Space" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * The reported symptom, as a test.
   *
   * The server re-snapshots every 3s and pushes the result, so the list
   * re-renders while you are reading it. Scrolling must survive that.
   */
  test("keeps its scroll position while the session updates", async ({ page }) => {
    await scenario(page, "crowded");
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();

    const scroller = page.locator(".scroll");
    await scroller.evaluate((el) => el.scrollTo(0, 400));
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);

    // Long enough for at least two pushes from the server.
    await page.waitForTimeout(8_000);

    const after = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(8);
  });

  test("opening an agent lands on that pane and back returns", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await tap(page, page.locator(".row").first());

    await expect(page).toHaveURL(/\/pane\//);
    // The header carries the task title; the cwd beside it is dropped at phone
    // width, where the title is what matters.
    await expect(page.locator(".detail__task")).toBeVisible({ timeout: 20_000 });

    await page.goBack();
    await expect(page.locator(".topbar__title")).toHaveText("Agents");
  });
});

test.describe("the states a dashboard can be in", () => {
  test("says so when nothing is running", async ({ page }) => {
    await scenario(page, "empty");
    await page.goto("/");

    await expect(page.locator(".empty")).toBeVisible();
    await expect(page.locator(".row, .blocked")).toHaveCount(0);
    // And the tab bar still says how many spaces there are: zero.
    await expect(page.locator(".tabbar__count")).toHaveText("0");
  });

  test("pins every waiting agent above the rest", async ({ page }) => {
    await scenario(page, "waiting");
    await page.goto("/");

    await expect(page.locator(".blocked")).toHaveCount(3);
    // Each card carries its own question, not a shared one.
    const questions = await page.locator(".blocked__question").allInnerTexts();
    expect(new Set(questions).size).toBeGreaterThan(1);
  });

  test("stays readable with twenty-eight agents", async ({ page }) => {
    await scenario(page, "crowded");
    await page.goto("/");

    await expect(page.locator(".row")).toHaveCount(28);
    // Grouped by space, every group is labelled and counted.
    await page.getByRole("button", { name: "Space" }).click();
    await expect(page.locator(".group__label")).toHaveCount(4);
    expect(await page.locator(".group__count").first().innerText()).toMatch(/^\d+$/);
  });

  test("a shell is not offered as an agent", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    // Three agents in this scenario, and a plain shell that belongs to Spaces.
    await expect(page.locator(".row, .blocked")).toHaveCount(3);
  });
});
