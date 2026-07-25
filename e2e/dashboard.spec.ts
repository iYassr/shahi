import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { isHarmless, tap } from "./touch";

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
    const problems = watchConsole(page);
    await page.goto("/");

    await expect(page.locator(".topbar__title")).toHaveText("Agents");
    await expect(page.locator(".row, .blocked").first()).toBeVisible();
    await expect(page.locator(".link--live")).toBeVisible();

    expect(problems).toEqual([]);
  });

  test("remembers how you grouped it", async ({ page }) => {
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
    await page.goto("/");
    await tap(page, page.locator(".row").first());

    await expect(page).toHaveURL(/\/pane\//);
    // The pane header shows where the agent is working rather than the row's
    // title, so this asserts arrival rather than the text.
    await expect(page.locator(".detail__where")).toBeVisible({ timeout: 20_000 });

    await page.goBack();
    await expect(page.locator(".topbar__title")).toHaveText("Agents");
  });
});
