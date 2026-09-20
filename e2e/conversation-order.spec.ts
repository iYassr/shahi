import { expect, test } from "./fixtures";
import { busySession } from "./stub/data";
import { push } from "./stub/control";

test("incoming messages reorder conversations across statuses without moving a pinned chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = busySession().session;
  const agents = session.panes.filter(p => p.isAgent);
  for (const [i, pane] of agents.entries()) {
    pane.lastMessageAt = [100, 300, 200][i];
    pane.title = ["Old waiting", "Newest chat", "Middle chat"][i]!;
  }
  await page.request.post("/__stub/scenario", { data: { name: "busy", patch: { session } } });
  await page.goto(`/pane/${encodeURIComponent(agents[0]!.paneId)}`);
  const titles = page.getByRole("complementary", { name: "Agent conversations" }).locator(".agent-row .row__title");
  await expect(titles).toContainText(["Newest chat", "Middle chat", "Old waiting"]);
  await page.getByRole("button", { name: "Pin Old waiting", exact: true }).click();
  await expect(titles).toContainText(["Old waiting", "Newest chat", "Middle chat"]);
  agents[2]!.lastMessageAt = 400;
  await push(page, { type: "session", session });
  await expect(titles).toContainText(["Old waiting", "Middle chat", "Newest chat"]);
});
