import { expect, test } from "./fixtures";

test.describe("getting around", () => {
  test("moves between agents and spaces", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /spaces/i }).click();
    await expect(page.locator(".topbar__title")).toHaveText("Spaces");
    await expect(page.locator(".row, .space").first()).toBeVisible();

    await page.getByRole("link", { name: /agents/i }).click();
    await expect(page.locator(".topbar__title")).toHaveText("Agents");
  });

  test("opens a space and its panes", async ({ page }) => {
    await page.goto("/spaces");
    await page.locator(".row, .space").first().click();
    await expect(page).toHaveURL(/\/space\//);
    await expect(page.locator(".row, .group, .tab-group").first()).toBeVisible();
  });

  test("survives a reload on a deep link", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));

    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);
    const url = page.url();

    await page.goto(url);
    await expect(page.locator(".detail__where")).toBeVisible();
    expect(problems).toEqual([]);
  });

  /**
   * The composer and key bar are the reason the app is sized to the visual
   * viewport. They have to be on screen, not under the fold.
   */
  test("keeps the composer reachable", async ({ page }) => {
    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);

    const composer = page.locator(".composer, .composer__input, textarea").first();
    await expect(composer).toBeInViewport();
  });
});
