import { expect, test as setup } from "@playwright/test";

const STATE = "e2e/.auth/state.json";

/**
 * Signs in once through the real form and keeps the cookie for every other
 * test — the session cookie is HttpOnly, so this is also the only way to have
 * it at all.
 */
setup("sign in", async ({ page }) => {
  // The stub's passcode by default; the live suite brings its own.
  const passcode = process.env.SHAHI_PASSCODE ?? "1234";

  await page.goto("/");
  await page.locator(".login input").fill(passcode);
  await page.getByRole("button", { name: /unlock|enter|sign/i }).click();

  await expect(page.locator(".topbar__title")).toHaveText("Agents");
  await page.context().storageState({ path: STATE });
});
