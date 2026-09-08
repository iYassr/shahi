import { test, expect } from "./fixtures";
import { scenario } from "./stub/control";

test("inbox reviews completed work without hiding questions or losing review on navigation", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/");
  await page.getByRole("button", { name: /^Inbox / }).click();
  await expect(page.getByRole("heading", { name: "What needs me?" })).toBeVisible();
  await expect(page.locator(".blocked").first()).toBeVisible();
  const review = page.getByRole("button", { name: /^Mark .* reviewed$/ }).first();
  await expect(review).toBeVisible();
  const label = await review.getAttribute("aria-label");
  await review.click();
  await expect(page.getByRole("button", { name: label!, exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /^Spaces/ }).click();
  await page.getByRole("link", { name: /^Agents/ }).click();
  await page.getByRole("button", { name: /^Inbox / }).click();
  await expect(page.getByRole("button", { name: label!, exact: true })).toHaveCount(0);
  await expect(page.locator(".blocked").first()).toBeVisible();
});
