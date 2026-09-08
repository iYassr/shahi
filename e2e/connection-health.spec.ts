import { test, expect } from "./fixtures";
import { scenario } from "./stub/control";

test("connection health preserves the loaded agents and clears after network recovery", async ({ page, context }) => {
  await scenario(page, "busy");
  await page.goto("/");
  await expect(page.locator(".row").first()).toBeVisible();
  await context.setOffline(true);
  await expect(page.locator(".connection-health")).toContainText("You’re offline");
  await expect(page.locator(".row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator(".connection-health")).toHaveCount(0);
  await expect(page.locator(".row").first()).toBeVisible();
});

test("a failed wake-up auth check preserves the open conversation and draft", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await expect(page.locator(".reader .msg").first()).toBeVisible();
  await page.locator("textarea").fill("Keep this draft");
  let checked = false;
  await page.route("**/api/auth/status", async (route) => { checked = true; await route.abort(); });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => checked).toBe(true);
  await expect(page.locator(".connection-health")).toContainText("Connection interrupted");
  await expect(page.locator("textarea")).toHaveValue("Keep this draft");
  await expect(page.locator(".reader .msg").first()).toBeVisible();
});
