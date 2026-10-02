import type { ControlHandshake } from "@shahi/shared";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";
import { tap } from "./touch";

/**
 * A development checkout, or any sidecar not run by the plugin's manager,
 * showed "Install the managed Shahi service on this computer to enable app
 * updates." on the agent list and in every conversation, and it could not be
 * dismissed (compatibility bug hunt). Older servers still send it as a
 * message, which is what this handshake is.
 */
const unmanaged: ControlHandshake = {
  control: 1, serverId: "stub-0000", buildId: "development", api: { min: 5, max: 5 }, capabilities: ["sessions"],
  backend: { state: "connected", version: "0.9.1", protocol: 22 },
  update: { managed: false, channel: "stable", phase: "idle", current: "development", message: "Install the managed Shahi service on this computer to enable app updates." },
};

test("an unmanaged computer's notice stays in Settings, off the agent list and the conversation", async ({ page }) => {
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: unmanaged });
  await page.goto("/settings");
  // Loaded: from here on, the same handshake decides every screen.
  await expect(page.locator(".computer-update")).toContainText("Install the managed Shahi service");
  await tap(page, page.getByRole("link", { name: /agents/i }).first());
  await expect(page.locator(".topbar__title").first()).toHaveText(/Agents/);
  await expect(page.locator(".row").first()).toBeVisible();
  await expect(page.locator(".computer-update")).toHaveCount(0);
  await tap(page, page.locator(".row").first());
  await expect(page).toHaveURL(/\/pane\//);
  await expect(page.locator(".computer-update")).toHaveCount(0);
});

// Build 32 said an unreachable computer was unreachable four times over on the
// Agents list, this card's "Computer unavailable. Your pairing is saved." one
// of them beside the connection card. That is the connection card's to say.
test("a computer that cannot be reached is said once, by the connection card, not by this card too", async ({ page, context }) => {
  await scenario(page, "busy");
  // herdr needing an update keeps this card up and its reads two seconds apart.
  await page.request.post("/__stub/control", { data: { ...unmanaged, capabilities: ["sessions", "computer-updates"], backend: { state: "update-required", message: "Update herdr on this computer." }, update: { managed: true, channel: "stable", phase: "idle", current: "0.3.6" } } });
  await page.goto("/");
  await expect(page.locator(".computer-update")).toContainText("Update required");
  await context.setOffline(true);
  await expect(page.locator(".connection-health")).toContainText("You’re offline");
  // The next read fails within two seconds; before, the card then said
  // "Computer unavailable. Your pairing is saved." for as long as it lasted.
  await expect(page.locator(".computer-update")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("Computer unavailable")).toHaveCount(0);
  await context.setOffline(false);
});

test("a managed computer's failure is still shown on the agent list", async ({ page }) => {
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: { ...unmanaged, capabilities: ["sessions", "computer-updates"], update: { managed: true, channel: "stable", phase: "rolled-back", current: "0.3.6", message: "The update did not start correctly. Your previous release and pairing have been restored." } } });
  await page.goto("/");
  await expect(page.locator(".computer-update")).toContainText("previous release and pairing have been restored");
});
