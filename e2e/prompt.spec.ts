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

  // The prompt's id goes back too: the same command asked for twice draws the
  // same card, and only the id tells them apart (pre-release bug hunt, B46).
  test("tapping an option submits its index, displayed label and the prompt's id", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    await page.locator(".choice", { hasText: "Green" }).click();

    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    const sent = await paneWrites(page);
    expect(sent[0]).toMatchObject({
      path: `/api/panes/${encodeURIComponent(BLOCKED_PANE)}/answer`,
      body: { index: 2, label: "Green", promptId: "stub-colour-question" },
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

  // Opened by its address, the pane was never watched, so no live frame ever
  // replaced the first read: after answering, the card stayed up saying
  // "Waiting on you" with every option disabled (pre-release bug hunt).
  test("answering in a pane opened by its address clears the card", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto(`/pane/${encodeURIComponent(BLOCKED_PANE)}`);
    await expect(page.locator(".blocked__question")).toHaveText("Which colour do you prefer?");
    await page.locator(".choice", { hasText: "Red" }).click();
    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    await expect(page.locator(".blocked")).toHaveCount(0);
    await expect(page.locator(".detail__title")).not.toHaveText("Waiting on you");
  });

  // In phone landscape, at 200% zoom or with the keyboard open, the pane's card
  // clipped its options and nothing scrolled to them: a Claude permission lost
  // "3. No, and tell Claude…" and a codex approval showed no options at all
  // (pre-release bug hunt). A script can scroll a clipped box, so the test
  // asks what a person can: every option is in view, or the card scrolls.
  for (const viewport of [{ width: 664, height: 390 }, { width: 390, height: 330 }]) {
    test(`every answer in a pane can be reached at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await scenario(page, "waiting");
      await page.setViewportSize(viewport);
      for (const paneId of ["w1:p1", "w1:p2", "w2:p1"]) {
        await page.goto(`/pane/${encodeURIComponent(paneId)}`);
        const card = page.locator(".detail > .blocked");
        await expect(card.locator(".choice").first()).toBeAttached();
        const reachable = await card.evaluate((el) => {
          const overflow = getComputedStyle(el).overflowY;
          const box = el.getBoundingClientRect();
          return [...el.querySelectorAll(".choice")].every((choice) => {
            const row = choice.getBoundingClientRect();
            return (row.top >= box.top - 1 && row.bottom <= box.bottom + 1) || overflow === "auto" || overflow === "scroll";
          });
        });
        expect(reachable, `${paneId}: an option is clipped with no way to scroll to it`).toBe(true);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
      }
      const last = page.locator(".detail > .blocked .choice").last();
      const index = Number((await last.locator(".choice__index").textContent())!.replace(".", ""));
      await tap(page, last);
      await expect.poll(async () => (await paneWrites(page)).map((w) => w.body.index)).toEqual([index]);
    });
  }

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

  // Every Claude permission offers "1. Yes": the server can only refuse a
  // stale card for one command on the screen of the next if the tap says what
  // the card showed (pre-release review).
  test("tapping an approval's answer says which question and command it was shown under", async ({ page }) => {
    await scenario(page, "waiting");
    await page.goto("/");

    const card = page.locator(".blocked", { hasText: "Would you like to run" });
    // Shown without codex's key; sent as the screen has it, below.
    await expect(card.locator(".choice").first()).toHaveText(/Yes, proceed$/);
    await card.locator(".choice", { hasText: "Yes, proceed" }).click();

    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    const [sent] = await paneWrites(page);
    expect(sent!.body).toMatchObject({
      index: 1,
      label: "Yes, proceed (y)",
      question: "Would you like to run the following command?",
      context: expect.arrayContaining([expect.stringContaining("$ sed -n")]),
    });
  });

  /**
   * Claude's edit approval, the first task of build 32: held to half the
   * column, the diff and question filled the card and "3. No" sat below its
   * edge — a question with no visible answer. The rules around the diff
   * wrapped into lines of dashes, and option 2 ended in "(shift+tab)".
   */
  test("an approval with a long diff keeps its answers on screen", async ({ page }) => {
    await scenario(page, "waiting");
    await page.goto(`/pane/${encodeURIComponent("w1:p2")}`);
    const card = page.locator(".detail > .blocked");
    await expect(card.locator(".blocked__question")).toHaveText("Do you want to make this edit to tip.py?");
    await expect(card.locator(".choice")).toHaveCount(3);

    // Every answer whole and in view, with nothing to scroll: not the card,
    // not the answers' own area, not the page.
    const layout = await card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const choices = el.querySelector(".choices")!;
      const area = choices.getBoundingClientRect();
      return {
        cardScrolls: el.scrollHeight > el.clientHeight + 1,
        choicesScroll: choices.scrollHeight > choices.clientHeight + 1,
        rows: [...el.querySelectorAll(".choice")].map((row) => {
          const r = row.getBoundingClientRect();
          return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.top >= area.top - 1 && r.bottom <= area.bottom + 1;
        }),
      };
    });
    expect(layout).toEqual({ cardScrolls: false, choicesScroll: false, rows: [true, true, true] });
    for (const row of await card.locator(".choice").all()) await expect(row).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();

    // The diff is bounded and scrolls in its own box, rules gone, code unwrapped.
    const context = card.locator(".asked__context");
    expect((await context.boundingBox())!.height).toBeLessThanOrEqual(140);
    await expect(context).not.toContainText("╌");
    await expect(context).toContainText("return round((total * (1 + tip / 100)) / people, 2)");
    // The line of code is drawn as one line, however narrow the phone.
    const rects = await context.evaluate((el) => {
      const line = "   2 -    return round((total + tip) / people, 2)";
      const node = [...el.querySelectorAll("p")].map((p) => p.firstChild!).find((n) => n.textContent!.includes(line))!;
      const range = document.createRange();
      range.setStart(node, node.textContent!.indexOf(line));
      range.setEnd(node, node.textContent!.indexOf(line) + line.length);
      return range.getClientRects().length;
    });
    expect(rects).toBe(1);

    // Shown without the key, sent as the screen has it.
    const second = card.locator(".choice").nth(1);
    await expect(second).not.toContainText("shift+tab");
    await second.click();
    await expect.poll(async () => (await paneWrites(page)).length).toBe(1);
    const [sent] = await paneWrites(page);
    expect(sent!.body).toMatchObject({ index: 2, label: expect.stringMatching(/for this session \(shift\+tab\)$/) });
  });

  // Any waiting card at phone size: every answer whole, nothing to scroll.
  // A cap on the answers as a share of the card once cut the colour
  // question's last choice with a third of the screen free.
  test("every waiting card's answers are on screen at phone size", async ({ page }) => {
    await scenario(page, "waiting");
    for (const paneId of ["w1:p1", "w1:p2", "w2:p1"]) {
      await page.goto(`/pane/${encodeURIComponent(paneId)}`);
      const card = page.locator(".detail > .blocked");
      await expect(card.locator(".choice").first()).toBeAttached();
      const scrolls = await card.evaluate((el) =>
        [el, el.querySelector(".choices")!].map((box) => box.scrollHeight > box.clientHeight + 1));
      expect(scrolls, paneId).toEqual([false, false]);
      for (const row of await card.locator(".choice").all()) await expect(row).toBeInViewport({ ratio: 1 });
    }
  });

  // Where even the whole column above the composer cannot hold the card, it
  // scrolls, and opens at its end: the answers, with the question a scroll
  // above them rather than the other way round.
  for (const viewport of [{ width: 390, height: 420 }, { width: 664, height: 390 }]) {
    test(`on a short screen a question opens at its answers at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await scenario(page, "waiting");
      await page.setViewportSize(viewport);
      await page.goto(`/pane/${encodeURIComponent("w1:p2")}`);
      const card = page.locator(".detail > .blocked");
      await expect(card.locator(".choice")).toHaveCount(3);
      // In landscape the card is shorter than its three answers together, so
      // the rule is what can hold: scrolled to its end, the last answer whole.
      const shown = await card.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const last = el.querySelector(".choice:last-child")!.getBoundingClientRect();
        return {
          scrolls: el.scrollHeight > el.clientHeight + 1,
          atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
          lastWhole: last.top >= box.top - 1 && last.bottom <= box.bottom + 1,
        };
      });
      expect(shown).toEqual({ scrolls: true, atEnd: true, lastWhole: true });
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
      // The question is a scroll away.
      await card.evaluate((el) => { el.scrollTop = 0; });
      await expect(card.locator(".blocked__question")).toBeInViewport();
    });
  }

  test("a blocked agent is pinned above everything else", async ({ page }) => {
    await scenario(page, "busy");
    await page.goto("/");

    const firstCard = page.locator(".blocked, .row").first();
    await expect(firstCard).toHaveClass(/blocked/);
  });
});
