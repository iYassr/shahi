import { test, expect } from "./fixtures";
import { scenario } from "./stub/control";

test("desktop keeps a searchable agent list beside the selected conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await scenario(page, "busy");
  await page.goto("/");
  await expect(page.locator(".conversation-welcome")).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Agent conversations" });
  await sidebar.getByRole("textbox", { name: "Search agents" }).fill("Convert PDF");
  await sidebar.locator(".row").first().click();
  await expect(page.locator(".detail")).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("textbox", { name: "Search agents" })).toHaveValue("Convert PDF");
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator(".detail__task .agent-avatar")).toBeVisible();
  const positions = await page.evaluate(() => {
    const left = document.querySelector(".agent-sidebar")!.getBoundingClientRect();
    const right = document.querySelector(".detail")!.getBoundingClientRect();
    return { leftEdge: left.right, rightEdge: right.left, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(positions.leftEdge).toBeLessThanOrEqual(positions.rightEdge);
  expect(positions.overflow).toBe(false);
});

test("resizing keeps the conversation and draft while mobile shows one screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await expect(page.locator(".reader .msg").first()).toBeVisible();
  await page.locator("textarea").fill("Keep this while resizing");
  const composer = await page.locator("textarea").elementHandle();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".agent-sidebar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("Keep this while resizing");
  expect(await composer!.evaluate(node => node === document.querySelector("textarea"))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".agent-sidebar")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("Keep this while resizing");
  await page.locator(".agent-sidebar .row").filter({ hasText: "Refactor the parser" }).click();
  await expect(page).toHaveURL(/w1%3Ap1/);
  await expect(page.locator("textarea")).toHaveValue("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".agent-sidebar")).toBeVisible();
  await expect(page.locator(".conversation-main")).toBeHidden();
});
