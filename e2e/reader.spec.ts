import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { tap } from "./touch";

/**
 * Finds a pane whose transcript the reader can actually show.
 *
 * Asked of the API rather than guessed from the list, so the suite follows the
 * session as it changes instead of pinning to whatever was running the day it
 * was written.
 */
async function readablePane(page: Page): Promise<string> {
  // Same-origin fetches need an origin: the helper runs before any navigation.
  if (!page.url().startsWith("http")) await page.goto("/");

  const panes = await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const found: string[] = [];
    for (const pane of session.panes) {
      if (!pane.isAgent) continue;
      const res = await fetch(`/api/panes/${encodeURIComponent(pane.paneId)}/session?limit=1`);
      if (res.ok) {
        const log = await res.json();
        if (log.total > 0) found.push(`${pane.paneId}:${log.total}`);
      }
    }
    return found;
  });

  // Prefer the longest conversation: pagination is only testable past one page.
  const best = panes
    .map((entry) => {
      const at = entry.lastIndexOf(":");
      return { paneId: entry.slice(0, at), total: Number(entry.slice(at + 1)) };
    })
    .sort((a, b) => b.total - a.total)[0];

  if (!best) test.skip(true, "no agent in this session has a transcript to read");
  return best!.paneId;
}

const openReader = async (page: Page, paneId: string) => {
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.locator(".reader .msg").first()).toBeVisible({ timeout: 30_000 });
};

test.describe("reader", () => {
  test("shows the conversation", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));

    const paneId = await readablePane(page);
    await openReader(page, paneId);

    await expect(page.locator(".msg--you, .msg--agent").first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  /**
   * The reader polls every 2.5s. Reading something older than the last page has
   * to survive that.
   */
  test("keeps earlier messages loaded across a poll", async ({ page }) => {
    const paneId = await readablePane(page);
    await openReader(page, paneId);

    const more = page.locator(".reader__more");
    test.skip((await more.count()) === 0, "this transcript fits in one page");

    const before = await page.locator(".reader .msg").count();
    await tap(page, more);
    await expect(page.locator(".reader .msg")).not.toHaveCount(before);
    const loaded = await page.locator(".reader .msg").count();

    // Two full poll cycles.
    await page.waitForTimeout(6_000);
    expect(await page.locator(".reader .msg").count()).toBeGreaterThanOrEqual(loaded);
  });

  /** Scrolled up to read something, a new poll must not drag the view away. */
  test("does not scroll itself while you are reading", async ({ page }) => {
    const paneId = await readablePane(page);
    await openReader(page, paneId);

    const reader = page.locator(".reader");
    await reader.evaluate((el) => el.scrollTo(0, Math.floor(el.scrollHeight / 3)));
    const before = await reader.evaluate((el) => el.scrollTop);

    await page.waitForTimeout(8_000);

    const after = await reader.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(8);
  });

  test("expanded tool output stays expanded across a poll", async ({ page }) => {
    const paneId = await readablePane(page);
    await openReader(page, paneId);

    const tool = page.locator(".tool__head").first();
    test.skip((await tool.count()) === 0, "no tool calls in this transcript");
    await tool.scrollIntoViewIfNeeded();
    await tap(page, tool);
    await expect(page.locator(".tool__out, .msg__aside").first()).toBeVisible();

    await page.waitForTimeout(6_000);
    await expect(page.locator(".tool__out, .msg__aside").first()).toBeVisible();
  });

  test("switches to the screen and back", async ({ page }) => {
    const paneId = await readablePane(page);
    await openReader(page, paneId);

    await page.getByRole("tab", { name: "Screen" }).click();
    await expect(page.locator(".termwrap")).toBeVisible();

    await page.getByRole("tab", { name: "Read" }).click();
    await expect(page.locator(".reader .msg").first()).toBeVisible();
  });
});
