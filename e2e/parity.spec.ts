import { expect, test } from "./fixtures";
import { scenario, writes } from "./stub/control";

for (const viewport of [{ width: 360, height: 780 }, { width: 1440, height: 900 }]) {
  test(`agent tools and settings fit ${viewport.width}px browsers`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await scenario(page, "busy");
    await page.goto("/");
    await expect(page.getByRole("button", { name: "+ New agent" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search agents" }).fill("Convert PDF");
    await expect(page.locator(".agent-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Pin Convert PDF to markdown", exact: true }).click();
    await expect(page.locator(".pinned-agent")).toContainText("Convert PDF");
    await page.reload();
    await expect(page.locator(".pinned-agent")).toContainText("Convert PDF");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Paired devices" })).toBeVisible();
    await expect(page.getByText("No paired devices.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("new agent can be started from Agents using the shared contract", async ({ page }) => {
  await scenario(page, "busy");
  await page.goto("/");
  await page.getByRole("button", { name: "+ New agent" }).click();
  await page.locator(".sheet .row").first().click();
  await expect(page.locator(".sheet__title")).toContainText("New agent in");
  await page.getByRole("button", { name: "Start claude", exact: true }).click();
  await expect.poll(async () => (await writes(page)).filter((w) => w.path === "/api/agents/start").length).toBe(1);
  const request = (await writes(page)).find((w) => w.path === "/api/agents/start");
  expect(request?.body).toMatchObject({ clientRequestId: expect.any(String), kind: "claude" });
});

test("uncertain prompt retry retains its id and submitted draft", async ({ page }) => {
  await scenario(page, "busy");
  const ids: string[] = [];
  await page.route("**/api/panes/*/prompt", async (route) => {
    const body = route.request().postDataJSON();
    ids.push(body.clientMessageId);
    if (ids.length === 1) await route.fulfill({ status: 503, json: { error: "Try again" } });
    else await route.fulfill({ json: { accepted: true, clientMessageId: body.clientMessageId, acceptedAt: Date.now() } });
  });
  await page.goto("/pane/w1%3Ap1");
  await page.locator("textarea").fill("one request only");
  await page.locator(".compose__send").click();
  await expect(page.locator("textarea")).toHaveValue("one request only");
  await expect(page.locator(".compose__send")).toBeEnabled();
  await page.locator(".compose__send").click();
  await expect(page.locator("textarea")).toHaveValue("");
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(page.getByText("one request only", { exact: true })).toBeVisible();
});

test("older pages use message indices, not transcript byte offsets", async ({ page }) => {
  await scenario(page, "busy");
  const messages = Array.from({ length: 145 }, (_, n) => ({ id: `history-${n}`, role: "agent", at: n, blocks: [{ kind: "text", text: `Historic message ${n}` }] }));
  const cursors: number[] = [];
  await page.route("**/api/panes/*/session?*", async (route) => {
    const url = new URL(route.request().url());
    const before = Number(url.searchParams.get("before") ?? messages.length);
    const limit = Number(url.searchParams.get("limit") ?? 60);
    if (url.searchParams.has("before")) cursors.push(before);
    await route.fulfill({ json: { sessionId: "long-history", path: "/stub/log", total: messages.length, offset: 987654, messages: messages.slice(Math.max(0, before - limit), before) } });
  });
  await page.goto("/pane/w1%3Ap1");
  await expect(page.locator(".reader .msg")).toHaveCount(60);
  await page.locator(".reader__more").click();
  await expect(page.locator(".reader .msg")).toHaveCount(120);
  await page.locator(".reader__more").click();
  await expect(page.locator(".reader .msg")).toHaveCount(145);
  await expect(page.locator(".reader__more")).toHaveCount(0);
  expect(cursors).toEqual([85, 25]);
});

test("Settings revokes the chosen paired device and signs out on the server", async ({ page }) => {
  await scenario(page, "busy");
  await page.route("**/api/devices", (route) => route.fulfill({ json: { devices: [{ id: "test-phone", name: "Test phone", createdAt: 1, lastSeenAt: 2 }], thisDeviceId: null } }));
  await page.goto("/settings");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect.poll(async () => (await writes(page)).some((w) => w.path === "/api/devices/test-phone" && w.method === "DELETE")).toBe(true);
  const logout = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/logout" && request.method() === "POST");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await logout;
  await expect(page.locator(".login")).toBeVisible();
});
