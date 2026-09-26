import { expect, test } from "./fixtures";
import { scenario, socketMessages } from "./stub/control";

test.describe("getting around", () => {
  test("moves between agents and spaces", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await page.getByRole("link", { name: /spaces/i }).click();
    await expect(page.locator(".topbar__title")).toHaveText("Spaces");
    await expect(page.locator(".row, .space").first()).toBeVisible();

    await page.getByRole("link", { name: /agents/i }).click();
    await expect(page.locator(".topbar__title")).toHaveText("Agents");
  });

  test("opens a space and its panes", async ({ page }) => {
    // Chosen here, not inherited from the test above: run alone or after a
    // test that left "empty", there was no space to open.
    await scenario(page, "busy");
    await page.goto("/spaces");
    await page.locator(".row, .space").first().click();
    await expect(page).toHaveURL(/\/space\//);
    await expect(page.locator(".row, .group, .tab-group").first()).toBeVisible();
  });

  test("survives a reload on a deep link", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));

    await scenario(page, "busy");
    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);
    const url = page.url();

    await page.goto(url);
    await expect(page.locator(".detail__task")).toBeVisible();
    expect(problems).toEqual([]);
  });

  /*
   * A pane opened by its address — a reload, a bookmark, a notification —
   * mounted in the same commit as the live socket and asked to be watched
   * before the socket existed. Nothing was watched: the Screen tab kept its
   * first frame and an answered card stayed on screen (pre-release bug hunt).
   */
  test("a pane opened by its address is watched, and again after a reload", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/pane/w1%3Ap2");
    await expect(page.locator(".detail__task")).toBeVisible();
    await expect.poll(async () => (await socketMessages(page)).filter((m) => m.type === "watch").map((m) => m.paneId)).toEqual(["w1:p2"]);

    await page.reload();
    await expect(page.locator(".detail__task")).toBeVisible();
    await expect.poll(async () => (await socketMessages(page)).filter((m) => m.type === "watch").map((m) => m.paneId)).toEqual(["w1:p2", "w1:p2"]);
  });

  /**
   * The composer and key bar are the reason the app is sized to the visual
   * viewport. They have to be on screen, not under the fold.
   */
  test("keeps the composer reachable", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");
    await page.locator(".row").first().click();
    await expect(page).toHaveURL(/\/pane\//);

    const composer = page.locator(".composer, .composer__input, textarea").first();
    await expect(composer).toBeInViewport();
  });
});
