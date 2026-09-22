import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";

/**
 * A new release, as a page that is already open meets it.
 *
 * Both cases came from the pre-release review, and both used to cost the
 * person work they had not finished.
 */

/** The shell the server now answers with names another bundle. */
async function deploy(page: Page) {
  // Only the update check's own fetch sees it; a real reload still gets the real app.
  await page.route((url) => url.pathname === "/", async (route) => {
    if (route.request().resourceType() !== "fetch") { await route.continue(); return; }
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/\/assets\/[^"']+\.js/, "/assets/synthetic-new-release.js") });
  });
}

/**
 * Drafts outlive the conversation they were typed in, on purpose, but only the
 * conversation on screen used to mark itself as unfinished work, so the
 * foreground update check reloaded away a draft — and an uncertain send's
 * operation ID — once the person had gone back to the list.
 */
test("an update waits for a draft in a conversation that is no longer open", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await page.locator("textarea").fill("Keep this draft");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("textarea")).toHaveCount(0);

  await deploy(page);
  await page.evaluate(() => { (window as { unreloaded?: boolean }).unreloaded = true; });
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));

  await expect(page.getByText(/A new version is ready/)).toBeVisible();
  expect(await page.evaluate(() => (window as { unreloaded?: boolean }).unreloaded)).toBe(true);
  // Back to the conversation inside the app, not by loading a page.
  await page.goBack();
  await expect(page.locator("textarea")).toHaveValue("Keep this draft");
});
