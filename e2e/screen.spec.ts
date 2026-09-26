import { expect, test } from "./fixtures";
import { scenario, writes } from "./stub/control";

test("screen zoom and focus preserve the terminal and draft", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await page.getByRole("tab", { name: "Screen", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("keep this draft");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Send text to terminal…");
  await page.getByRole("button", { name: "Full size", exact: true }).click();
  await expect(page.getByRole("button", { name: "Full size", exact: true })).toHaveText("100%");
  const originalWidth = await page.locator(".term").evaluate((el) => el.getBoundingClientRect().width);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Full size", exact: true })).toHaveText("110%");
  await expect.poll(async () => (await page.locator(".term").evaluate((el) => el.getBoundingClientRect().width)) / originalWidth).toBeCloseTo(1.1, 2);
  await page.locator(".xterm").evaluate((el) => el.setAttribute("data-focus-check", "preserved"));
  await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
  await expect(page.locator(".compose")).toBeHidden();
  await expect(page.getByRole("tablist")).toBeHidden();
  await expect(page.locator(".xterm")).toHaveAttribute("data-focus-check", "preserved");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("keep this draft");
  await expect(page.getByRole("button", { name: "Focus terminal", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await expect(page.getByRole("button", { name: "Fit width", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator(".termwrap").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
  await page.getByRole("button", { name: "Exit focus view", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

/*
 * xterm's hidden input kept focus once it had it. `disableStdin` only stops
 * xterm sending input; its key handler still turned Tab, Shift+Tab and Escape
 * into terminal sequences and cancelled them, so a keyboard could reach the
 * Screen tab and never leave it, and Escape could not close focus view
 * (pre-release bug hunt).
 */
test("a keyboard moves past the terminal and Escape still leaves focus view", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await page.getByRole("tab", { name: "Screen", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  const insideTerminal = () => page.evaluate(() => !!document.activeElement?.closest(".term"));

  await page.getByRole("tab", { name: "Screen", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeFocused();

  await page.locator(".xterm").click();
  await page.keyboard.press("Tab");
  expect(await insideTerminal()).toBe(false);
  await page.locator(".xterm").click();
  await page.keyboard.press("Shift+Tab");
  expect(await insideTerminal()).toBe(false);

  await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
  await expect(page.locator(".compose")).toBeHidden();
  await page.locator(".xterm").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".compose")).toBeVisible();
  await expect(page.getByRole("button", { name: "Focus terminal", exact: true })).toBeFocused();
  expect((await writes(page)).filter((w) => w.path.includes("/keys"))).toEqual([]);
});

// Drawn as a labelled image, the screen had no words a screen reader could
// reach: role="img" made everything inside it presentational (pre-release bug
// hunt).
test("the screen's text reaches a screen reader", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/pane/w1%3Ap2");
  await page.getByRole("tab", { name: "Screen", exact: true }).click();
  const screen = page.getByRole("region", { name: "Terminal output", exact: true });
  await expect(screen).toContainText("184 pass");
  await expect(screen).toContainText("x@host:~/project (main)");
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toHaveCount(0);
});
