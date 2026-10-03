import type { ControlHandshake } from "@shahi/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { tap } from "./touch";
import { paneWrites, scenario } from "./stub/control";

/**
 * The composer's slash-command picker and quick replies (October 2026), in
 * both engines. Every write is recorded by the stub rather than performed:
 * what is asserted is the text the app sends, which must be exactly what a
 * person typing it would have sent.
 *
 * w2:p1 is a codex pane that has finished its turn, w1:p2 one still working,
 * and w1:p3 a shell (see `busySession`).
 */
const handshake: ControlHandshake = {
  control: 1, serverId: "stub-0000", buildId: "development", api: { min: 5, max: 5 }, capabilities: ["sessions", "commands"],
  backend: { state: "connected", version: "0.9.1", protocol: 22 },
  update: { managed: false, channel: "beta", phase: "idle", current: "0.3.22" },
};

async function open(page: Page, paneId = "w2:p1") {
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}
const sentTexts = async (page: Page) => (await paneWrites(page)).filter((w) => w.path.endsWith("/prompt")).map((w) => w.body.text);

test.describe("the slash-command picker", () => {
  test("typing / offers the agent's commands; choosing one fills the reply, and Send sends it as typed", async ({ page }) => {
    await scenario(page, "busy");
    await open(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("/");
    const list = page.getByRole("listbox", { name: "Commands" });
    await expect(list.getByRole("option", { name: /^\/model/ })).toBeVisible();
    await box.fill("/co");
    await expect(list.getByRole("option")).toHaveCount(1);
    await tap(page, list.getByRole("option", { name: /^\/compact/ }));
    await expect(box).toHaveValue("/compact ");
    await expect(list).toHaveCount(0);
    expect(await sentTexts(page)).toEqual([]);

    await tap(page, page.locator(".compose__send"));
    await expect.poll(() => sentTexts(page)).toEqual(["/compact"]);
    const [write] = await paneWrites(page);
    expect(write!.body.clientMessageId).toEqual(expect.any(String));
  });

  test("the arrow keys move through the commands, Enter chooses one, and Escape closes the list", async ({ page }) => {
    await scenario(page, "busy");
    await open(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("/");
    await box.press("ArrowDown");
    await expect(page.getByRole("option", { selected: true })).toHaveText(/^\/compact/);
    await box.press("Enter");
    await expect(box).toHaveValue("/compact ");

    await box.fill("/n");
    await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
    await box.press("Escape");
    await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
    await expect(box).toHaveValue("/n");
  });

  test("a computer that lists commands is asked for the pane's, and the list is what it answers", async ({ page }) => {
    await scenario(page, "busy");
    await page.request.post("/__stub/control", { data: handshake });
    await open(page);
    const asked = page.waitForRequest((request) => request.url().endsWith("/api/panes/w2%3Ap1/commands"));
    await page.getByRole("textbox", { name: "Message" }).fill("/");
    await asked;
    await expect(page.getByRole("option", { name: /^\/status/ })).toBeVisible();
  });

  test("a shell gets no picker: a slash there is the terminal's", async ({ page }) => {
    await scenario(page, "busy");
    await open(page, "w1:p3");
    await page.getByRole("textbox", { name: "Message" }).fill("/");
    await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
  });
});

test.describe("quick replies", () => {
  test("a finished agent offers them, and one tap sends the reply exactly as typed", async ({ page }) => {
    await scenario(page, "busy");
    await open(page);
    const replies = page.getByRole("group", { name: "Quick replies" });
    await expect(replies.getByRole("button", { name: "Commands" })).toBeVisible();
    await tap(page, replies.getByRole("button", { name: "Continue" }));
    await expect.poll(() => sentTexts(page)).toEqual(["Continue"]);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });

  test("a typed draft hides them, so a tap can never replace or discard it", async ({ page }) => {
    await scenario(page, "busy");
    await open(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("only the parser tests");
    await expect(page.getByRole("group", { name: "Quick replies" })).toHaveCount(0);
    await expect(box).toHaveValue("only the parser tests");
    expect(await sentTexts(page)).toEqual([]);
  });

  test("a working agent and a shell are offered none", async ({ page }) => {
    await scenario(page, "busy");
    await open(page, "w1:p2");
    await expect(page.getByRole("group", { name: "Quick replies" })).toHaveCount(0);
    await open(page, "w1:p3");
    await expect(page.getByRole("group", { name: "Quick replies" })).toHaveCount(0);
  });

  test("they are one row that scrolls sideways, and the reply box stays put as they come and go", async ({ page }) => {
    await scenario(page, "busy");
    await open(page);
    const replies = page.getByRole("group", { name: "Quick replies" });
    await expect(replies).toBeVisible();
    const row = (await replies.boundingBox())!;
    expect(row.height).toBeLessThan(60);
    expect(await replies.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const chip of await replies.getByRole("button").all()) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const box = page.getByRole("textbox", { name: "Message" });
    const before = (await box.boundingBox())!;
    await box.fill("x");
    await expect(replies).toHaveCount(0);
    const after = (await box.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });
});
