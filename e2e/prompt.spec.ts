import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { paneWrites, scenario } from "./stub/control";
import { tap } from "./touch";

/**
 * Answering a blocked agent — the thing the whole app exists to do.
 *
 * Driven against a stubbed session rather than a live one. A real blocked agent
 * would mean starting an agent, provoking a question and pressing a key into
 * somebody's actual work; this asserts the same behaviour without touching it.
 * The live path has been exercised by hand, end to end, on the phone.
 */

/**
 * The stub stages this: the `waiting` scenario has three blocked agents, each
 * asking something different, and records what the app sends back rather than
 * doing it.
 */
const BLOCKED_PANE = "w1:p1";

test.describe("answering a prompt", () => {
  test("the card carries the question, the options and their explanations", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    await expect(page.locator(".blocked")).toBeVisible();
    await expect(page.getByText("Which colour do you prefer?")).toBeVisible();
    await expect(page.locator(".choice")).toHaveCount(4);
    await expect(page.getByText("Warm, high-contrast.")).toBeVisible();
    // The cursor sits where the terminal had it.
    await expect(page.locator(".choice").first()).toHaveAttribute("data-selected", "true");
  });

  test("tapping an option submits its index and displayed label", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    await page.locator(".choice", { hasText: "Green" }).click();

    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    const sent = await paneWrites(page);
    expect(sent[0]).toMatchObject({
      path: `/api/panes/${encodeURIComponent(BLOCKED_PANE)}/answer`,
      body: { index: 2, label: "Green" },
    });
  });

  test("the card stops offering answers once one has been sent", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    await page.locator(".choice", { hasText: "Green" }).click();

    // The options go the moment the answer lands: the agent is no longer asking,
    // and a second tap would put a stray keystroke into a live session.
    await expect(page.locator(".choice")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(await paneWrites(page)).toHaveLength(1);
  });

  test("a failure says so and leaves the question answerable", async ({ page }) => {
    await scenario(page, "busy");
    // The one case the stub cannot stage: herdr itself refusing.
    await page.route("**/api/panes/*/answer", (route) =>
      route.fulfill({ status: 400, json: { error: "herdr pane.send_keys failed" } }),
    );
    await page.goto("/");

    await page.locator(".choice", { hasText: "Blue" }).click();
    await expect(page.locator(".toast")).toBeVisible();
    await expect(page.locator(".choice").first()).toBeEnabled();
  });

  test("the same prompt is answerable from inside the pane", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto(`/pane/${encodeURIComponent(BLOCKED_PANE)}`);
    await expect(page.locator(".detail__task")).toBeVisible();

    // The pane draws the question three times over — the prompt card, the
    // reader's record of it, and the tool summary — so be specific about which.
    await expect(page.locator(".blocked__question")).toHaveText("Which colour do you prefer?");
    await page.locator(".choice", { hasText: "Red" }).click();
    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    const sent = await paneWrites(page);
    expect(sent[0]).toMatchObject({ body: { index: 1, label: "Red" } });
  });

  /**
   * A codex approval carries a command longer than the screen. Taken as the
   * question it wrapped across eight lines and pushed the answers out of view,
   * which is what "the codex permission prompt does not show" meant.
   */
  test("an approval shows the question, the command, and the answers together", async ({
    page,
  }) => {
    await scenario(page, "waiting");
    await page.goto("/");

    const card = page.locator(".blocked", { hasText: "Would you like to run" });
    await expect(card.locator(".blocked__question")).toHaveText(
      "Would you like to run the following command?",
    );
    await expect(card.locator(".asked__context")).toContainText("$ sed -n");
    await expect(card.locator(".choice")).toHaveCount(3);

    // The command is capped and scrolls rather than pushing the answers away.
    const context = await card.locator(".asked__context").boundingBox();
    expect(context!.height).toBeLessThanOrEqual(140);
  });

  test("a blocked agent is pinned above everything else", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    const firstCard = page.locator(".blocked, .row").first();
    await expect(firstCard).toHaveClass(/blocked/);
  });
});
