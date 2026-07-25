import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";
import { expectDrawn, tap } from "./touch";

/**
 * Files, images and questions in the reader.
 *
 * Reading that an agent rewrote `prompt-parser.ts` is not the same as being
 * able to look at it, and a screenshot shrunk into a phone-width column is not
 * the same as seeing it. Both open full screen, and both can be kept.
 *
 * `w1:p1` in the `busy` scenario carries one of every block kind, with file
 * references pointing at files the stub really serves and a real 240x160 PNG
 * behind the images — the fixture used to be a transparent pixel, so "is the
 * thumbnail drawn?" could only ever measure 3px of border. That is how a
 * collapsed thumbnail got past this suite.
 */

const PANE = "w1:p1";

const openPane = async (page: Page) => {
  await scenario(page, "busy");
  await page.goto(`/pane/${encodeURIComponent(PANE)}`);
  await expect(page.locator(".reader .msg").first()).toBeVisible({ timeout: 20_000 });
};

test.describe("a question the agent asked", () => {
  /**
   * It used to render as a collapsed row named after the tool, with the choices
   * thrown away — so from a phone there was nothing to read. Reported by
   * someone who could not see what they were being asked.
   */
  test("shows the question and every option without expanding anything", async ({ page }) => {
    await openPane(page);

    await expect(page.locator(".asked__q")).toHaveText("Which colour do you prefer?");
    await expect(page.locator(".asked__option")).toHaveCount(2);
    await expect(page.locator(".asked__label").first()).toContainText("Red");
    await expect(page.locator(".asked__why").first()).toHaveText("Warm, high-contrast.");
  });

  test("numbers them the way the terminal does, so answering by digit lines up", async ({
    page,
  }) => {
    await openPane(page);

    await expect(page.locator(".asked__label").first()).toHaveText(/^1\.\s+Red$/);
    await expect(page.locator(".asked__label").last()).toHaveText(/^2\.\s+Green$/);
  });
});

test.describe("files in the reader", () => {
  test("every tool call that named a file offers it", async ({ page }) => {
    await openPane(page);

    // Two calls named a file; the Bash calls named none and get no row.
    await expect(page.locator(".tool__file")).toHaveCount(2);
    await expect(page.locator(".tool__open").first()).toHaveText("prompt-parser.ts");
  });

  test("opening one shows what is in it", async ({ page }) => {
    await openPane(page);

    await tap(page, page.locator(".tool__open").first());
    await expect(page.locator(".viewer")).toBeVisible();
    await expect(page.locator(".viewer__name")).toHaveText("prompt-parser.ts");
    await expect(page.locator(".viewer__text")).toContainText("OPTION_RE", { timeout: 20_000 });
  });

  test("the viewer closes and leaves the conversation where it was", async ({ page }) => {
    await openPane(page);

    await tap(page, page.locator(".tool__open").first());
    await expect(page.locator(".viewer")).toBeVisible();
    await tap(page, page.locator(".viewer__close"));

    await expect(page.locator(".viewer")).toHaveCount(0);
    await expect(page.locator(".reader .msg").first()).toBeVisible();
  });

  test("an image file opens as an image, not as text", async ({ page }) => {
    await openPane(page);

    await tap(page, page.locator(".tool__open").last());
    await expectDrawn(page.locator(".viewer__image"), 100, 60);
  });

  test("a file can be downloaded", async ({ page }) => {
    await openPane(page);

    const download = page.waitForEvent("download");
    await tap(page, page.locator(".tool__get").first());
    expect((await download).suggestedFilename()).toBe("prompt-parser.ts");
  });

  test("an image in the conversation opens full screen", async ({ page }) => {
    await openPane(page);

    await tap(page, page.locator(".msg__zoom").first());
    await expect(page.locator(".viewer__image")).toBeVisible();
    await expect(page.locator(".viewer__get")).toBeVisible();
  });

  /**
   * iOS does not reliably deliver a tap to a bare `<img>`, whatever handlers it
   * carries — which is why the image meant to open full screen did nothing on a
   * phone and could only be downloaded. A button always gets it.
   */
  test("the image is a button, not an image with a handler", async ({ page }) => {
    await openPane(page);

    const tag = await page
      .locator(".msg__image")
      .first()
      .evaluate((el) => el.parentElement?.tagName);
    expect(tag).toBe("BUTTON");
  });

  /**
   * And the button must not eat it: WebKit renders a button through a box of
   * its own, and an image inside one collapsed to nothing on the phone while
   * drawing correctly everywhere else.
   */
  test("the thumbnail is actually drawn inside that button", async ({ page }) => {
    await openPane(page);

    await expectDrawn(page.locator(".msg__image").first(), 40, 40);
    const image = await page.locator(".msg__image").first().boundingBox();
    const button = await page.locator(".msg__zoom").first().boundingBox();
    // No dead strip under the picture.
    expect(button!.height - image!.height).toBeLessThan(24);
  });

  test("a file that cannot be read says why, rather than showing a broken image", async ({
    page,
  }) => {
    await openPane(page);
    // The file vanishing between the transcript being written and it being
    // opened — an agent cleaning up after itself, which happens constantly.
    await page.route("**/api/file**", (route) =>
      route.fulfill({ status: 403, json: { error: "that path is outside the roots" } }),
    );

    await tap(page, page.locator(".tool__open").first());
    await expect(page.locator(".viewer .empty")).toContainText(/outside|cannot/i, {
      timeout: 20_000,
    });
    // The download is still offered: the bytes may yet be reachable.
    await expect(page.locator(".viewer__get, .empty__action")).not.toHaveCount(0);
  });
});
