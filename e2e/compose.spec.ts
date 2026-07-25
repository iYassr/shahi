import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { tap } from "./touch";

/**
 * Saying something to an agent: the composer, the key bar, attachments.
 *
 * Every write is intercepted. Sending a real message would put text into
 * somebody's actual session, and the assertions here are about what the app
 * sends rather than what herdr does with it.
 */

async function recordWrites(page: Page): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route("**/api/rpc", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { result: { type: "ok" } } });
  });
  return sent;
}

const openPane = async (page: Page) => {
  await page.goto("/");
  await tap(page, page.locator(".row").first());
  await expect(page).toHaveURL(/\/pane\//);
  await expect(page.locator("textarea")).toBeVisible();
};

test.describe("the composer", () => {
  test("sends the text, then Enter, in that order", async ({ page }) => {
    const sent = await recordWrites(page);
    await openPane(page);

    await page.locator("textarea").fill("hello from a test");
    await tap(page, page.locator(".compose__send"));

    await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(2);
    expect(sent[0]).toMatchObject({
      method: "pane.send_text",
      params: { text: "hello from a test" },
    });
    expect(sent[1]).toMatchObject({ method: "pane.send_keys", params: { keys: ["Enter"] } });
  });

  test("clears itself once the message is away", async ({ page }) => {
    await recordWrites(page);
    await openPane(page);

    await page.locator("textarea").fill("something");
    await tap(page, page.locator(".compose__send"));
    await expect(page.locator("textarea")).toHaveValue("", { timeout: 10_000 });
  });

  test("will not send nothing", async ({ page }) => {
    await recordWrites(page);
    await openPane(page);
    await expect(page.locator(".compose__send")).toBeDisabled();

    await page.locator("textarea").fill("   ");
    await expect(page.locator(".compose__send")).toBeDisabled();
  });

  test("keeps the draft when a message fails", async ({ page }) => {
    await page.route("**/api/rpc", (route) =>
      route.fulfill({ status: 400, json: { error: "pane is gone" } }),
    );
    await openPane(page);

    await page.locator("textarea").fill("worth keeping");
    await tap(page, page.locator(".compose__send"));

    await expect(page.locator(".toast")).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("worth keeping");
  });

  test("every key in the bar sends the name herdr expects", async ({ page }) => {
    const sent = await recordWrites(page);
    await openPane(page);

    const expected: Record<string, string> = {
      esc: "Escape",
      "⇥": "Tab",
      "⇧⇥": "shift+tab",
      "^C": "C-c",
      "^D": "C-d",
      "↑": "Up",
      "↓": "Down",
      "⏎": "Enter",
    };

    for (const [label, key] of Object.entries(expected)) {
      // Exact text: "⇥" is a substring of "⇧⇥".
      await page.locator(".keys button").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).click();
      await expect.poll(() => sent.length).toBeGreaterThan(0);
      expect(sent.at(-1)).toMatchObject({ params: { keys: [key] } });
    }
    expect(sent).toHaveLength(Object.keys(expected).length);
  });
});

test.describe("attachments", () => {
  test("a server file becomes a path on its own line", async ({ page }) => {
    const sent = await recordWrites(page);
    await openPane(page);

    await tap(page, page.locator(".compose__attach"));
    await expect(page.locator(".sheet")).toBeVisible();
    await page.getByRole("button", { name: /on the server/i }).click();

    // Browse into whatever the first file in this directory is.
    const file = page.locator(".picker__row[data-kind='file'], .picker__row").last();
    await file.click();

    await expect(page.locator(".attached__chip")).toHaveCount(1);
    await page.locator("textarea").fill("have a look at this");
    await tap(page, page.locator(".compose__send"));

    await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(2);
    const body = (sent[0] as { params: { text: string } }).params.text;
    // Path first, message after: an agent reads the path, and the sentence
    // after it is what to do with it.
    expect(body.split("\n")).toHaveLength(2);
    expect(body.split("\n")[0]).toMatch(/^\//);
    expect(body.split("\n")[1]).toBe("have a look at this");
  });

  test("an attachment can be taken off again", async ({ page }) => {
    await recordWrites(page);
    await openPane(page);

    await tap(page, page.locator(".compose__attach"));
    await page.getByRole("button", { name: /on the server/i }).click();
    await page.locator(".picker__row").last().click();
    await expect(page.locator(".attached__chip")).toHaveCount(1);

    await page.locator(".attached__x").click();
    await expect(page.locator(".attached__chip")).toHaveCount(0);
  });

  test("a file from the phone is uploaded and referenced by path", async ({ page }) => {
    await recordWrites(page);
    let uploaded = false;
    await page.route("**/api/uploads", async (route) => {
      uploaded = true;
      await route.fulfill({
        json: { name: "photo.png", path: "/home/x/uploads/photo.png", size: 12, type: "image/png" },
      });
    });

    await openPane(page);
    await tap(page, page.locator(".compose__attach"));
    await expect(page.locator(".sheet")).toBeVisible();

    await page.locator("input[type=file]").first().setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from("not really a png"),
    });

    await expect.poll(() => uploaded).toBe(true);
    await expect(page.locator(".attached__chip")).toContainText("photo.png");
  });

  test("an upload that fails says so", async ({ page }) => {
    await page.route("**/api/uploads", (route) =>
      route.fulfill({ status: 413, json: { error: "file is too large" } }),
    );
    await openPane(page);
    await tap(page, page.locator(".compose__attach"));
    await page.locator("input[type=file]").first().setInputFiles({
      name: "big.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
    });

    await expect(page.locator(".toast, .sheet__error")).toBeVisible();
    await expect(page.locator(".attached__chip")).toHaveCount(0);
  });
});
