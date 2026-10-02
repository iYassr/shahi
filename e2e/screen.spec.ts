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

// An agent waiting on something no parser recognised: messages are refused,
// so Read shows the screen as the terminal has it, with the keys to answer.
test("an unrecognised wait shows its screen in Read, and its keys reach the pane", async ({ page }) => {
  await scenario(page, "busy");
  const screen = ["", "Security notes:", "", "1. Claude can make mistakes.", "", "Press Enter to continue…", "", ""].join("\n");
  // A codex pane with no question on the session, so only the screen asks.
  const patched = await page.request.post("/__stub/scenario", { data: { patch: { unrecognised: ["w2:p1"], screens: { "w2:p1": screen } } } });
  expect(patched.ok()).toBe(true);
  await page.goto("/pane/w2%3Ap1");
  const card = page.getByRole("region", { name: "Waiting on something Shahi cannot read" });
  await expect(card).toBeVisible();
  await expect(card.getByLabel("Terminal screen")).toHaveText("Security notes:\n\n1. Claude can make mistakes.\n\nPress Enter to continue…");
  await card.getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(async () => (await writes(page)).filter((w) => w.path === "/api/panes/w2%3Ap1/keys").map((w) => (w.body as { keys: string[] }).keys)).toEqual([["Enter"]]);
  await card.getByRole("button", { name: "Open Screen", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(card).toBeHidden();
});

// Right after its folder trust was answered, an idle Claude waiting for its
// first message showed this card with a question's amber border, and read as
// something that needed you (first-task test of build 32, on the native app;
// this card is the same).
test("a new agent's screen is information, not an alarm, until the agent waits on it", async ({ page }) => {
  await scenario(page, "busy");
  const screen = ["", "╭───╮", "│ ✻ Welcome to Claude Code │", "╰───╯", "", "❯ Try \"fix the failing test\"", ""].join("\n");
  // A conversation with nothing in it yet, so Read shows the screen.
  const patched = await page.request.post("/__stub/scenario", { data: { patch: { transcripts: { "w2:p1": [] }, screens: { "w2:p1": screen } } } });
  expect(patched.ok()).toBe(true);
  const border = (card: import("@playwright/test").Locator) => card.evaluate((el) => {
    const accent = document.createElement("span");
    accent.style.color = "var(--accent)";
    document.body.append(accent);
    const amber = getComputedStyle(accent).color;
    accent.remove();
    return { border: getComputedStyle(el).borderTopColor, amber };
  });

  await page.goto("/pane/w2%3Ap1");
  const idle = page.getByRole("region", { name: "On the computer's screen" });
  await expect(idle).toBeVisible();
  const quiet = await border(idle);
  expect(quiet.border).not.toBe(quiet.amber);
  await expect(idle.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();

  await page.request.post("/__stub/scenario", { data: { patch: { unrecognised: ["w2:p1"] } } });
  await page.reload();
  const waiting = page.getByRole("region", { name: "Waiting on something Shahi cannot read" });
  await expect(waiting).toBeVisible();
  const loud = await border(waiting);
  expect(loud.border).toBe(loud.amber);
});
