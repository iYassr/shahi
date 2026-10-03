import type { ControlHandshake, PaneChanges } from "@shahi/shared";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";

/**
 * The Changes view (October 2026): the owner asked to review what an agent
 * changed, as a diff, from the phone. In both engines: shown only by a
 * computer that offers it, a file's lines numbered and coloured, and a line
 * wider than the phone scrolled to rather than wrapped.
 */
const handshake = (capabilities: ControlHandshake["capabilities"]): ControlHandshake => ({
  control: 1, serverId: "stub-0000", buildId: "development", api: { min: 5, max: 5 }, capabilities,
  backend: { state: "connected", version: "0.9.1", protocol: 22 },
  update: { managed: false, channel: "stable", phase: "idle", current: "0.3.22" },
});

test("a computer that offers Changes lists what the agent changed and opens a file's diff, scrolled sideways rather than wrapped", async ({ page }) => {
  // The narrowest phone the browser suite holds layouts to, with a fourth tab.
  await page.setViewportSize({ width: 360, height: 780 });
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: handshake(["sessions", "changes"]) });
  await page.goto("/pane/w1%3Ap1");
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const files = page.getByRole("list", { name: "Changed files" });
  await expect(page.getByText("feature/cart")).toBeVisible();
  await expect(files.getByRole("button")).toHaveCount(5);
  await expect(files.getByRole("button", { name: "src/checkout/total.ts, renamed from src/total.ts, 1 line added, 1 removed" })).toBeVisible();
  await expect(files.getByRole("button", { name: "assets/logo.png, untracked" })).toBeVisible();

  await files.getByRole("button", { name: "src/cart.ts, modified, 3 lines added, 2 removed" }).click();
  const diff = page.getByRole("region", { name: "Changes to src/cart.ts" });
  await expect(diff.locator(".diff__row[data-kind=added]")).toHaveCount(3);
  await expect(diff.locator(".diff__row[data-kind=removed]")).toHaveCount(2);
  // Numbered from the hunk: the first removed line was line 11 in the commit.
  await expect(diff.locator(".diff__row[data-kind=removed] .diff__num").first()).toHaveText("11");
  await expect(page.getByText("… 1,234 more lines, too many to show here.")).toBeVisible();
  // The wide line keeps one row's height and the view scrolls to it.
  const wide = diff.locator(".diff__row").filter({ hasText: "a line far wider" });
  const narrow = diff.locator(".diff__row[data-kind=context]").first();
  expect(Math.round((await wide.boundingBox())!.height)).toBe(Math.round((await narrow.boundingBox())!.height));
  expect(await diff.evaluate((el) => el.scrollWidth > el.clientWidth + 100)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "‹ All changes" }).click();
  await files.getByRole("button", { name: "assets/logo.png, untracked" }).click();
  await expect(page.getByText("This is a binary file, so there are no lines to show.")).toBeVisible();
});

test("a pane outside any repository is told so calmly, not as an error", async ({ page }) => {
  await scenario(page, "busy");
  const outside: PaneChanges = { repository: null, note: "This folder is not in a Git repository, so there are no changes to show.", files: [], omitted: 0 };
  await page.request.post("/__stub/scenario", { data: { patch: { changes: { "w1:p1": { list: outside, diffs: {} } } } } });
  await page.request.post("/__stub/control", { data: handshake(["sessions", "changes"]) });
  await page.goto("/pane/w1%3Ap1");
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await expect(page.getByText(outside.note!)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a computer without it offers no Changes tab", async ({ page }) => {
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: handshake(["sessions"]) });
  // Judged once the handshake has arrived: before it, no computer offers anything.
  const asked = page.waitForResponse((response) => response.url().endsWith("/api/control/handshake"));
  await page.goto("/pane/w1%3Ap1");
  await asked;
  await expect(page.getByRole("tab", { name: "Screen", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveCount(0);
});
