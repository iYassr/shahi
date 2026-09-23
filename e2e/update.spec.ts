import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";

/**
 * A new release, as a page that is already open meets it.
 *
 * Both cases came from the pre-release review, and both used to cost the
 * person work they had not finished.
 */

/**
 * Types once the conversation has drawn, as a person would. Text filled in the
 * first few milliseconds after the page loaded was occasionally gone again in
 * WebKit before the next step.
 */
async function draftIn(page: Page, paneId: string, text: string) {
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.locator(".reader .msg").first()).toBeVisible();
  await page.locator("textarea").fill(text);
  await expect(page.locator("textarea")).toHaveValue(text);
}

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
 * A lazily loaded chunk the server no longer has. A rejected `React.lazy`
 * stays rejected, so the error screen replaced the whole app, and both of its
 * ways out were page loads.
 */
test("a terminal removed by a deploy offers the update instead of breaking the app", async ({ page }) => {
  await scenario(page, "busy");
  await draftIn(page, "w1:p2", "Keep this draft");
  await page.route("**/assets/Terminal-*", (route) => route.fulfill({ status: 404, body: "not found" }));
  await deploy(page);
  await page.getByRole("tab", { name: "Screen", exact: true }).click();
  await expect(page.getByText(/could not be loaded/)).toBeVisible();
  await expect(page.getByText(/A new version is ready/)).toBeVisible();
  await expect(page.getByText(/Something in the app broke/)).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveValue("Keep this draft");
});

/**
 * Drafts outlive the conversation they were typed in, on purpose, but only the
 * conversation on screen used to mark itself as unfinished work, so the
 * foreground update check reloaded away a draft — and an uncertain send's
 * operation ID — once the person had gone back to the list.
 */
test("an update waits for a draft in a conversation that is no longer open", async ({ page }) => {
  // The foreground check runs at most once a minute, and the page's own first
  // pageshow can use that turn when sign-in finishes first — which made this
  // pass alone and fail in WebKit in the full run. Time is moved past it below.
  await page.clock.install();
  await scenario(page, "busy");
  await draftIn(page, "w1:p2", "Keep this draft");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator("textarea")).toHaveCount(0);

  await deploy(page);
  await page.evaluate(() => { (window as { unreloaded?: boolean }).unreloaded = true; });
  await page.clock.fastForward("01:01");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));

  await expect(page.getByText(/A new version is ready/)).toBeVisible();
  expect(await page.evaluate(() => (window as { unreloaded?: boolean }).unreloaded)).toBe(true);
  // Back to the conversation inside the app, not by loading a page.
  await page.goBack();
  await expect(page.locator("textarea")).toHaveValue("Keep this draft");
});
