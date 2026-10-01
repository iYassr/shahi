import type { ControlHandshake, PlanUsage } from "@shahi/shared";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";

/**
 * Settings' Claude Code and Codex plan usage (October 2026), in both engines:
 * shown only by a computer that offers it, Codex's at once, Claude Code's
 * behind a switch whose cost is said beside it.
 */
const handshake: ControlHandshake = {
  control: 1, serverId: "stub-0000", buildId: "development", api: { min: 5, max: 5 }, capabilities: ["sessions", "plan-usage"],
  backend: { state: "connected", version: "0.9.1", protocol: 22 },
  update: { managed: false, channel: "beta", phase: "idle", current: "0.3.19" },
};
const now = Date.now();
const codex = { observedAt: now - 3_600_000, plan: "pro", windows: [{ label: "Weekly", usedPercent: 53, resetsAt: now + 2 * 86_400_000 }] };
const off: PlanUsage = { claude: { enabled: false, usage: null }, codex: { usage: codex }, checkedAt: now };
const on: PlanUsage = { ...off, claude: { enabled: true, usage: { observedAt: now - 60_000, windows: [{ label: "5-hour", usedPercent: 24, resetsAt: now + 3_600_000 }] } } };

test("a computer that offers plan usage shows Codex's limits and a switch for Claude Code's", async ({ page }) => {
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: handshake });
  const switched: unknown[] = [];
  await page.route("**/api/plan-usage", (route) => route.fulfill({ json: off }));
  await page.route("**/api/plan-usage/claude", (route) => { switched.push(route.request().postDataJSON()); return route.fulfill({ json: on }); });
  await page.goto("/settings");
  const codexSection = page.getByRole("region", { name: "Codex plan usage" });
  await expect(codexSection.getByRole("meter", { name: "Weekly limit" })).toHaveAttribute("aria-valuetext", "53% used");
  await expect(codexSection).toContainText("Pro");
  const claude = page.getByRole("region", { name: "Claude Code plan usage" });
  await expect(claude).toContainText("hides its footer hints");
  // The switch shows what the computer answered, as the phone's does, so it turns
  // on only after the request returns. `check()` demands the new state at the
  // moment of the click: WebKit's route answered in time, Chromium's did not.
  const toggle = claude.getByRole("switch", { name: "Show plan usage" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(claude.getByRole("meter", { name: "5-hour limit" })).toHaveAttribute("aria-valuetext", "24% used");
  expect(switched).toEqual([{ enabled: true }]);
});

test("a computer that does not offer it shows no Agents sections", async ({ page }) => {
  await scenario(page, "busy");
  await page.request.post("/__stub/control", { data: { ...handshake, capabilities: ["sessions"] } });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /Devices with access/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex plan usage" })).toHaveCount(0);
});
