import { expect, test, type Page } from "@playwright/test";

/**
 * Answering a blocked agent — the thing the whole app exists to do.
 *
 * Driven against a stubbed session rather than a live one. A real blocked agent
 * would mean starting an agent, provoking a question and pressing a key into
 * somebody's actual work; this asserts the same behaviour without touching it.
 * The live path has been exercised by hand, end to end, on the phone.
 */

const BLOCKED = {
  paneId: "wT:p1",
  workspaceId: "wT",
  workspaceLabel: "test space",
  tabId: "wT:t1",
  status: "blocked",
  agent: "claude",
  title: "Refactor the parser",
  cwd: "~/project",
  focused: false,
  hasPrompt: true,
  isAgent: true,
  prompt: {
    question: "Which colour do you prefer?",
    options: [
      { index: 1, label: "Red", selected: true, detail: "Warm, high-contrast." },
      { index: 2, label: "Green", selected: false, detail: "Reads as success." },
      { index: 3, label: "Blue", selected: false },
    ],
  },
};

const SESSION = {
  version: "0.7.5",
  protocol: 17,
  defaultGrouping: null,
  workspaces: [
    {
      workspaceId: "wT",
      label: "test space",
      status: "blocked",
      paneCount: 1,
      tabCount: 1,
      focused: false,
      cwd: "~/project",
      cwdPath: "/home/x/project",
    },
  ],
  tabs: [
    {
      tabId: "wT:t1",
      workspaceId: "wT",
      label: "1",
      number: 1,
      status: "blocked",
      paneCount: 1,
      focused: false,
    },
  ],
  panes: [BLOCKED],
  focusedPaneId: null,
};

/**
 * Serves a fixed session, and records what the app sends back.
 *
 * The websocket has to be stubbed as well as the fetch: the dashboard is
 * push-fed, and a live connection would overwrite the fixture with the real
 * session a moment after the page loaded.
 */
async function stub(page: Page, session: unknown = SESSION): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.routeWebSocket("**/ws", (ws) => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ type: "session", session }));
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: session }));
  await page.route("**/api/rpc", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { result: { type: "ok" } } });
  });
  return sent;
}

test.describe("answering a prompt", () => {
  test("the card carries the question, the options and their explanations", async ({ page }) => {
    await stub(page);
    await page.goto("/");

    await expect(page.locator(".blocked")).toBeVisible();
    await expect(page.getByText("Which colour do you prefer?")).toBeVisible();
    await expect(page.locator(".choice")).toHaveCount(3);
    await expect(page.getByText("Warm, high-contrast.")).toBeVisible();
    // The cursor sits where the terminal had it.
    await expect(page.locator(".choice").first()).toHaveAttribute("data-selected", "true");
  });

  test("tapping an option presses its digit", async ({ page }) => {
    const sent = await stub(page);
    await page.goto("/");

    await page.locator(".choice", { hasText: "Green" }).click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({
      method: "pane.send_keys",
      params: { pane_id: "wT:p1", keys: ["2"] },
    });
  });

  test("the card stops offering answers once one has been sent", async ({ page }) => {
    const sent = await stub(page);
    await page.goto("/");

    await page.locator(".choice", { hasText: "Green" }).click();

    // The options go the moment the answer lands: the agent is no longer asking,
    // and a second tap would put a stray keystroke into a live session.
    await expect(page.locator(".choice")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(sent).toHaveLength(1);
  });

  test("a failure says so and leaves the question answerable", async ({ page }) => {
    await page.routeWebSocket("**/ws", (ws) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify({ type: "session", session: SESSION }));
    });
    await page.route("**/api/session", (route) => route.fulfill({ json: SESSION }));
    await page.route("**/api/rpc", (route) =>
      route.fulfill({ status: 400, json: { error: "herdr pane.send_keys failed" } }),
    );
    await page.goto("/");

    await page.locator(".choice", { hasText: "Blue" }).click();
    await expect(page.locator(".toast")).toBeVisible();
    await expect(page.locator(".choice").first()).toBeEnabled();
  });

  test("the same prompt is answerable from inside the pane", async ({ page }) => {
    const sent = await stub(page);
    await page.route("**/api/panes/**", (route) =>
      route.fulfill({ json: { pane: BLOCKED, frame: null, layout: null } }),
    );
    await page.goto("/pane/wT%3Ap1");

    await expect(page.getByText("Which colour do you prefer?")).toBeVisible();
    await page.locator(".choice", { hasText: "Red" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ params: { keys: ["1"] } });
  });

  test("a blocked agent is pinned above everything else", async ({ page }) => {
    const busy = {
      ...BLOCKED,
      paneId: "wT:p2",
      status: "working",
      hasPrompt: false,
      prompt: null,
      title: "Something else",
    };
    await stub(page, { ...SESSION, panes: [busy, BLOCKED] });
    await page.goto("/");

    const firstCard = page.locator(".blocked, .row").first();
    await expect(firstCard).toHaveClass(/blocked/);
  });
});
