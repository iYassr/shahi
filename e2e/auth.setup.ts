import { expect, test as setup } from "@playwright/test";

const STATE = "e2e/.auth/state.json";

/**
 * Signs in once through the real form and keeps the cookie for every other
 * test — the session cookie is HttpOnly, so this is also the only way to have
 * it at all.
 */
setup("sign in", async ({ page }) => {
  const passcode = process.env.HERDRUI_PASSCODE;
  if (!passcode) throw new Error("Set HERDRUI_PASSCODE to the app passcode");

  await page.goto("/");
  await page.locator(".login input").fill(passcode);
  await page.getByRole("button", { name: /unlock|enter|sign/i }).click();

  await expect(page.locator(".topbar__title")).toHaveText("Agents");
  await page.context().storageState({ path: STATE });
});
