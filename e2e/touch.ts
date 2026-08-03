import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Interactions as a finger performs them.
 *
 * `click()` dispatches mouse events, which every engine delivers to anything.
 * A phone dispatches touch events, and WebKit is selective about where those
 * land — an `onClick` on a bare `<img>` gets mouse clicks in a test and
 * nothing at all from a thumb. Tapping instead of clicking is what turns that
 * difference into a failing test rather than a message from the person using
 * the app.
 *
 * Falls back to a click where the context has no touch (a desktop project),
 * so the same spec runs in both.
 */
export async function tap(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();

  const hasTouch = await page.evaluate(() => "ontouchstart" in window);
  if (hasTouch) await target.tap();
  else await target.click();
}

/**
 * Asserts that something is actually drawn, not merely present.
 *
 * The thumbnail bug was an element that existed, had a `src`, and occupied no
 * space — Chromium drew it, WebKit did not. Presence is not the assertion;
 * area is.
 */
export async function expectDrawn(target: Locator, minWidth = 8, minHeight = 8): Promise<void> {
  await expect(target).toBeVisible();

  /*
   * Polled, because an image has no size until its bytes arrive.
   *
   * A single measurement passed on this machine for months and failed the first
   * time it ran on a CI runner: 2px wide, which is what WebKit reports for an
   * `<img>` whose intrinsic size it does not know yet. The bug being guarded
   * against is a *permanent* collapse — an image that never takes up space —
   * and waiting distinguishes that from one that has simply not loaded on a
   * slower box.
   */
  await expect(async () => {
    const box = await target.boundingBox();
    expect(box, "should have a layout box").not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(minWidth);
    expect(box!.height).toBeGreaterThanOrEqual(minHeight);
  }).toPass({ timeout: 10_000 });
}

/**
 * Console noise that is the engine's opinion, not the app's fault.
 *
 * WebKit logs an unrecognised viewport key as an *error*, and the key in
 * question — `interactive-widget` — is there for Chrome on Android, which does
 * honour it. Failing a test over that would mean choosing between two engines
 * for no benefit.
 */
const HARMLESS = [/interactive-widget/i, /Unrecognized Content-Security-Policy/i];

export function isHarmless(message: string): boolean {
  return HARMLESS.some((pattern) => pattern.test(message));
}
