import { expect, test } from "@playwright/test";

/**
 * A few read-only checks against the real server.
 *
 * The scenario suite runs against a stub, which is what makes it deterministic
 * and safe — and which means it cannot notice the day the real server starts
 * answering differently. This is the part that can: it asserts shapes, not
 * behaviour, and it never writes.
 *
 *   SHAHI_URL=https://host SHAHI_PASSCODE=… bun run test:e2e --project=live
 */

const passcode = process.env.SHAHI_PASSCODE;

test.skip(!process.env.SHAHI_URL, "set SHAHI_URL to run against the real server");

test("the real server still speaks the contract the stub imitates", async ({ request }) => {
  const login = await request.post("/api/auth/login", { data: { passcode } });
  expect(login.ok(), "passcode should be accepted").toBe(true);

  const session = await (await request.get("/api/session")).json();
  expect(Array.isArray(session.panes)).toBe(true);
  expect(Array.isArray(session.workspaces)).toBe(true);
  expect(Array.isArray(session.tabs)).toBe(true);
  expect(typeof session.protocol).toBe("number");

  for (const pane of session.panes.slice(0, 3)) {
    expect(pane).toMatchObject({
      paneId: expect.any(String),
      workspaceId: expect.any(String),
      status: expect.stringMatching(/^(idle|working|blocked|done|unknown)$/),
      isAgent: expect.any(Boolean),
    });
  }
});

test("a real transcript still has the shape the reader draws", async ({ request }) => {
  await request.post("/api/auth/login", { data: { passcode } });
  const session = await (await request.get("/api/session")).json();

  for (const pane of session.panes.filter((p: { isAgent: boolean }) => p.isAgent)) {
    const res = await request.get(`/api/panes/${encodeURIComponent(pane.paneId)}/session?limit=5`);
    if (!res.ok()) continue;

    const log = await res.json();
    expect(typeof log.total).toBe("number");
    for (const message of log.messages) {
      expect(message.role).toMatch(/^(you|agent|system)$/);
      for (const block of message.blocks) {
        // Every kind the client knows how to draw. A new one appearing here
        // means the reader is about to render nothing for it.
        expect(block.kind).toMatch(/^(text|thinking|image|tool)$/);
      }
    }
    return;
  }
  test.skip(true, "no agent in this session has a transcript");
});

test("the dashboard renders against the real thing", async ({ page }) => {
  await page.goto("/");
  await page.locator(".login input").fill(passcode!);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator(".topbar__title")).toHaveText("Agents");
  await expect(page.locator(".row, .blocked, .empty").first()).toBeVisible();
});
