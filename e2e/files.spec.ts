import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectDrawn, tap } from "./touch";

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

/** The pane itself, so the app does not conclude it has been closed. */
const PANE_DETAIL = {
  pane: {
    paneId: PANE,
    workspaceId: "wF",
    workspaceLabel: "stub",
    tabId: "wF:t1",
    status: "idle",
    agent: "claude",
    title: "Stub",
    cwd: "~/stub",
    focused: false,
    hasPrompt: false,
    isAgent: true,
    prompt: null,
  },
  frame: null,
  layout: null,
};

async function stubPane(page: Page): Promise<void> {
  await page.route(`**/api/panes/${encodeURIComponent(PANE)}`, (route) =>
    route.fulfill({ json: PANE_DETAIL }),
  );
}

async function stubTranscript(page: Page): Promise<void> {
  await stubPane(page);
  const body = JSON.parse(JSON.stringify(LOG).replace("__FILE__", REAL_FILE));
  await page.route("**/api/panes/*/session*", (route) => route.fulfill({ json: body }));
  await page.route("**/api/panes/*/image*", (route) =>
    route.fulfill({
      contentType: "image/png",
      /*
       * A real 240x160 image, not a transparent pixel.
       *
       * The fixture used to be 1x1, so "is the thumbnail drawn?" could only
       * ever measure 3px of border and the assertion was meaningless — which
       * is how a thumbnail collapsing on the phone got past it.
       */
      body: Buffer.from(
        "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",
        "base64",
      ),
    }),
  );
}

test.describe("a question the agent asked", () => {
  const asked = {
    sessionId: "stub",
    path: "/x",
    offset: 0,
    total: 1,
    messages: [
      {
        id: "q1",
        role: "agent",
        at: 0,
        blocks: [
          {
            kind: "tool",
            name: "AskUserQuestion",
            summary: "Which colour?",
            questions: [
              {
                text: "Which colour?",
                options: [
                  { label: "Red", description: "Warm, high-contrast." },
                  { label: "Green" },
                ],
              },
            ],
            result: null,
          },
        ],
      },
    ],
  };

  /**
   * It used to render as a collapsed row named after the tool, with the choices
   * thrown away — so from a phone there was nothing to read. Reported by
   * someone who could not see what they were being asked.
   */
  test("shows the question and every option without expanding anything", async ({ page }) => {
    await stubPane(page);
    await page.route("**/api/panes/*/session*", (route) => route.fulfill({ json: asked }));
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await expect(page.locator(".asked__q")).toHaveText("Which colour?");
    await expect(page.locator(".asked__option")).toHaveCount(2);
    await expect(page.locator(".asked__label").first()).toContainText("Red");
    await expect(page.locator(".asked__why").first()).toHaveText("Warm, high-contrast.");
  });

  test("numbers them the way the terminal does, so answering by digit lines up", async ({
    page,
  }) => {
    await stubPane(page);
    await page.route("**/api/panes/*/session*", (route) => route.fulfill({ json: asked }));
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await expect(page.locator(".asked__label").first()).toHaveText(/^1\.\s+Red$/);
    await expect(page.locator(".asked__label").last()).toHaveText(/^2\.\s+Green$/);
  });
});

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

    await tap(page, page.locator(".tool__open").first());
    await expect(page.locator(".viewer")).toBeVisible();
    await expect(page.locator(".viewer__name")).toHaveText("notes.md");
    await expect(page.locator(".viewer__text")).toContainText("HerdrUI", { timeout: 20_000 });
  });

  test("the viewer closes and leaves the conversation where it was", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await tap(page, page.locator(".tool__open").first());
    await expect(page.locator(".viewer")).toBeVisible();
    await tap(page, page.locator(".viewer__close"));
    await expect(page.locator(".viewer")).toHaveCount(0);
    await expect(page.locator(".msg").first()).toBeVisible();
  });

  test("it can be downloaded", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    const download = page.waitForEvent("download");
    await tap(page, page.locator(".tool__get").first());
    const file = await download;
    // The server's Content-Disposition names it, which is why the stub points
    // the block at a file that really exists — the name follows the bytes.
    expect(file.suggestedFilename()).toBe("README.md");
  });

  test("an image in the conversation opens full screen", async ({ page }) => {
    await stubTranscript(page);
    await page.goto(`/pane/${encodeURIComponent(PANE)}`);

    await tap(page, page.locator(".msg__zoom").first());
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

    await expectDrawn(page.locator(".msg__image").first(), 40, 40);
    const box = await page.locator(".msg__image").first().boundingBox();

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
    await stubPane(page);
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

    await tap(page, page.locator(".tool__open").first());
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
