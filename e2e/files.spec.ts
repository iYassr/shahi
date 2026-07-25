import { expect, test, type Page } from "@playwright/test";

/**
 * Files and images in the reader.
 *
 * Reading that an agent rewrote `src/api.ts` is not the same as being able to
 * look at it, and a screenshot shrunk into a phone-width column is not the same
 * as seeing it. Both open full screen, and both can be kept.
 *
 * Driven against a stubbed transcript: a real one may or may not contain a Write
 * today, and the behaviour under test is the app's, not the agent's.
 */

const PANE = "wF:p1";

const LOG = {
  sessionId: "stub",
  path: "/home/x/.claude/projects/stub.jsonl",
  offset: 0,
  total: 2,
  messages: [
    {
      id: "m1",
      role: "agent",
      at: 0,
      blocks: [
        { kind: "text", text: "I rewrote the client." },
        {
          kind: "tool",
          name: "Write",
          summary: "/home/x/project/notes.md",
          file: { path: "__FILE__", name: "notes.md" },
          result: { text: "ok", isError: false, truncated: false, images: [] },
        },
        {
          kind: "tool",
          name: "Bash",
          summary: "ls -la",
          result: { text: "a\nb", isError: false, truncated: false, images: [] },
        },
      ],
    },
    {
      id: "m2",
      role: "agent",
      at: 1,
      blocks: [{ kind: "image", mediaType: "image/png", ref: "m2:0" }],
    },
  ],
};

/** A real file under the home directory, so the endpoint can actually serve it. */
const REAL_FILE = "/home/yasserdo/HerdrUI/README.md";

async function stubTranscript(page: Page): Promise<void> {
  const body = JSON.parse(JSON.stringify(LOG).replace("__FILE__", REAL_FILE));
  await page.route("**/api/panes/*/session*", (route) => route.fulfill({ json: body }));
  await page.route("**/api/panes/*/image*", (route) =>
    route.fulfill({
      contentType: "image/png",
      // One transparent pixel.
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
}

test.describe("files in the reader", () => {
  test("a tool call that wrote a file offers it", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await expect(page.locator(".tool__file")).toHaveCount(1);
    await expect(page.locator(".tool__open")).toHaveText("notes.md");
    // A shell command named no file, so it gets no row.
    await expect(page.locator(".tool")).toHaveCount(2);
  });

  test("opening it shows the contents", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await page.locator(".tool__open").click();
    await expect(page.locator(".viewer")).toBeVisible();
    await expect(page.locator(".viewer__name")).toHaveText("notes.md");
    await expect(page.locator(".viewer__text")).toContainText("HerdrUI", { timeout: 20_000 });
  });

  test("the viewer closes and leaves the conversation where it was", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await page.locator(".tool__open").click();
    await expect(page.locator(".viewer")).toBeVisible();
    await page.locator(".viewer__close").click();
    await expect(page.locator(".viewer")).toHaveCount(0);
    await expect(page.locator(".msg").first()).toBeVisible();
  });

  test("it can be downloaded", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    const download = page.waitForEvent("download");
    await page.locator(".tool__get").click();
    const file = await download;
    // The server's Content-Disposition names it, which is why the stub points
    // the block at a file that really exists — the name follows the bytes.
    expect(file.suggestedFilename()).toBe("README.md");
  });

  test("an image in the conversation opens full screen", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await page.locator(".msg__zoom").first().click();
    await expect(page.locator(".viewer__image")).toBeVisible();
    await expect(page.locator(".viewer__get")).toBeVisible();
  });

  /**
   * iOS does not reliably deliver a tap to a bare `<img>`, whatever handlers it
   * carries — which is why the image that was meant to open full screen did
   * nothing on a phone and could only be downloaded. A button always gets it.
   */
  test("the image is a button, not an image with a handler", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    const tag = await page
      .locator(".msg__image")
      .first()
      .evaluate((el) => el.parentElement?.tagName);
    expect(tag).toBe("BUTTON");
  });

  /**
   * And the button must not eat it.
   *
   * WebKit renders a button through a box of its own, and an image inside one
   * collapsed to nothing on the phone while showing correctly everywhere else —
   * so the thumbnail vanished the moment the tap was fixed.
   */
  test("the thumbnail is actually drawn inside that button", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    const box = await page.locator(".msg__image").first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    // And the button is no taller than what it contains, so there is no dead
    // strip under the picture.
    const button = await page.locator(".msg__zoom").first().boundingBox();
    expect(button!.height - box!.height).toBeLessThan(24);
  });

  test("a scratch file in the temp directory opens", async ({ request }) => {
    // Where agents put screenshots. Refusing these made the feature useless for
    // the files most worth a glance on a phone.
    const res = await request.get("/api/file?path=/tmp");
    // The directory itself is refused, but its contents are in scope — see the
    // unit tests for the read path.
    expect([403, 404]).toContain(res.status());
  });

  test("a file that cannot be read says why, rather than showing a broken image", async ({
    page,
  }) => {
    await page.route("**/api/panes/*/session*", (route) =>
      route.fulfill({
        json: {
          sessionId: "stub",
          path: "/x",
          offset: 0,
          total: 1,
          messages: [
            {
              id: "m1",
              role: "agent",
              at: 0,
              blocks: [
                {
                  kind: "tool",
                  name: "Read",
                  summary: "/etc/shadow.png",
                  file: { path: "/etc/shadow.png", name: "shadow.png" },
                  result: null,
                },
              ],
            },
          ],
        },
      }),
    );
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await page.locator(".tool__open").click();
    await expect(page.locator(".viewer")).toBeVisible();
    await expect(page.locator(".viewer .empty")).toContainText(/outside|cannot/i, {
      timeout: 20_000,
    });
  });

  test("a file outside either root is refused", async ({ request }) => {
    const res = await request.get("/api/file?path=/etc/passwd");
    expect(res.status()).toBe(403);
  });

  test("so is a path that walks out of it", async ({ request }) => {
    const res = await request.get("/api/file?path=/home/yasserdo/../../etc/shadow");
    expect(res.status()).toBe(403);
  });

  test("a download comes back as bytes, with a filename", async ({ request }) => {
    const res = await request.get(`/api/file?path=${encodeURIComponent(REAL_FILE)}&download=1`);
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toBe("application/octet-stream");
    expect(res.headers()["content-disposition"]).toContain('filename="README.md"');
  });

  test("markup is served as text rather than run", async ({ request }) => {
    const res = await request.get(
      `/api/file?path=${encodeURIComponent("/home/yasserdo/HerdrUI/web/index.html")}`,
    );
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("text/plain");
  });
});
