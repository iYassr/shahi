import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { isHarmless, tap } from "./touch";
import { scenario } from "./stub/control";

/**
 * A pane whose transcript the stub always provides — `w1:p1` has one of every
 * block kind, `w1:p2` has a long conversation for pagination.
 */
const READABLE = "w1:p1";
const LONG = "w1:p2";

const openReader = async (page: Page, paneId = READABLE) => {
  await scenario(page, "busy");
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.locator(".reader .msg").first()).toBeVisible({ timeout: 30_000 });
};

test.describe("reader", () => {
  test("shows the conversation", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => {
    if (m.type() === "error" && !isHarmless(m.text())) problems.push(m.text());
  });

    await openReader(page);

    await expect(page.locator(".msg--you, .msg--agent").first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  /**
   * The reader polls every 2.5s. Reading something older than the last page has
   * to survive that.
   */
  test("keeps earlier messages loaded across a poll", async ({ page }) => {
    await openReader(page, LONG);

    const more = page.locator(".reader__more");

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
    await openReader(page);

    const reader = page.locator(".reader");
    await reader.evaluate((el) => el.scrollTo(0, Math.floor(el.scrollHeight / 3)));
    const before = await reader.evaluate((el) => el.scrollTop);

    await page.waitForTimeout(8_000);

    const after = await reader.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(8);
  });

  test("expanded tool output stays expanded across a poll", async ({ page }) => {
    await openReader(page);

    const tool = page.locator(".tool__head").first();
    await tool.scrollIntoViewIfNeeded();
    await tap(page, tool);
    await expect(page.locator(".tool__out, .msg__aside").first()).toBeVisible();

    await page.waitForTimeout(6_000);
    await expect(page.locator(".tool__out, .msg__aside").first()).toBeVisible();
  });

  test("switches to the screen and back", async ({ page }) => {
    await openReader(page);

    await page.getByRole("tab", { name: "Screen" }).click();
    await expect(page.locator(".termwrap")).toBeVisible();

    await page.getByRole("tab", { name: "Read" }).click();
    await expect(page.locator(".reader .msg").first()).toBeVisible();
  });
});

test.describe("finding your way back down", () => {
  /**
   * Reading back through a long conversation, the way home was a long flick —
   * and there was no way to tell whether the agent had said anything while you
   * were up there.
   */
  test("offers a way back once you have scrolled off the end", async ({ page }) => {
    await openReader(page, LONG);
    const reader = page.locator(".reader");

    await expect(page.locator(".reader__jump")).toHaveCount(0);

    await reader.evaluate((el) => el.scrollTo(0, 0));
    await expect(page.locator(".reader__jump")).toBeVisible();
    await expect(page.locator(".reader__jump")).toHaveText(/latest/i);
  });

  test("tapping it returns to the newest message", async ({ page }) => {
    await openReader(page, LONG);
    const reader = page.locator(".reader");

    await reader.evaluate((el) => el.scrollTo(0, 0));
    await tap(page, page.locator(".reader__jump"));

    await expect.poll(async () =>
      reader.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    ).toBeLessThan(80);
    // And it goes away again, because there is nowhere left to go.
    await expect(page.locator(".reader__jump")).toHaveCount(0);
  });

  test("says how much arrived while you were reading", async ({ page }) => {
    await openReader(page, LONG);
    await page.locator(".reader").evaluate((el) => el.scrollTo(0, 0));
    await expect(page.locator(".reader__jump")).toBeVisible();

    // Two more messages land while the view is up the page.
    await page.request.post("/__stub/scenario", {
      data: {
        patch: {
          transcripts: {
            "w1:p2": [
              ...(await (await page.request.get("/api/panes/w1%3Ap2/session?limit=400")).json())
                .messages,
              { id: "new-1", role: "agent", at: 1, blocks: [{ kind: "text", text: "One more." }] },
              { id: "new-2", role: "agent", at: 2, blocks: [{ kind: "text", text: "And another." }] },
            ],
          },
        },
      },
    });

    await expect(page.locator(".reader__jump")).toHaveText(/2 new/, { timeout: 20_000 });
  });

  // Twelve or more messages between polls reset the reader to the newest
  // twelve: the loaded history and the message being read were gone, and the
  // count of new messages was never raised (pre-release bug hunt).
  test("a burst of messages keeps the loaded history and counts every new one", async ({ page }) => {
    await openReader(page, LONG);
    await tap(page, page.locator(".reader__more"));
    await expect(page.locator(".reader .msg")).toHaveCount(120);
    await page.locator(".reader").evaluate((el) => el.scrollTo(0, 0));
    await expect(page.locator(".reader__jump")).toBeVisible();

    const existing = (await (await page.request.get("/api/panes/w1%3Ap2/session?limit=400")).json()).messages;
    const burst = Array.from({ length: 20 }, (_, i) => ({ id: `burst-${i}`, role: "agent", at: 10 + i, blocks: [{ kind: "text", text: `Burst ${i}.` }] }));
    await page.request.post("/__stub/scenario", { data: { patch: { transcripts: { "w1:p2": [...existing, ...burst] } } } });

    await expect(page.locator(".reader__jump")).toHaveText(/20 new/, { timeout: 20_000 });
    await expect(page.locator(".reader .msg")).toHaveCount(140);
    await expect(page.locator(".reader__more")).toHaveText("Load earlier (20 more)");
  });

  // More than one page can bridge still starts again at the newest messages,
  // but counted from the transcript: from the window the count came out
  // negative and was skipped, leaving a stale one (pre-release bug hunt).
  test("a gap too long to bridge starts at the newest messages and counts them all", async ({ page }) => {
    await openReader(page, LONG);
    await page.locator(".reader").evaluate((el) => el.scrollTo(0, 0));
    await expect(page.locator(".reader__jump")).toBeVisible();

    const existing = (await (await page.request.get("/api/panes/w1%3Ap2/session?limit=400")).json()).messages;
    const flood = Array.from({ length: 500 }, (_, i) => ({ id: `flood-${i}`, role: "agent", at: 10 + i, blocks: [{ kind: "text", text: `Flood ${i}.` }] }));
    await page.request.post("/__stub/scenario", { data: { patch: { transcripts: { "w1:p2": [...existing, ...flood] } } } });

    await expect(page.locator(".reader__more")).toHaveText("Load earlier (628 more)", { timeout: 20_000 });
    await expect(page.locator(".reader__jump")).toHaveText(/500 new/);
  });
});
