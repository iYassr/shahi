import { expect, test } from "./fixtures";
import { writes } from "./stub/control";
import { modesFor, agentLabel } from "../shared/src/index";
const kinds = ["pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki", "muse"];
for (const entry of ["agents", "spaces"]) for (const kind of kinds) {
  for (const mode of modesFor(kind).length ? modesFor(kind) : [null]) {
    test(`${entry}: ${kind}/${mode?.id ?? "default"} opens its own conversation`, async ({ page }) => {
      const reset = await page.request.post("/__stub/scenario", { data: { name: "busy", patch: { agents: kinds, createAgents: true } } });
      expect(reset.ok()).toBe(true);
      await page.goto(entry === "agents" ? "/" : "/space/w1");
      await page.getByRole("button", { name: "+ New agent", exact: true }).click();
      if (entry === "agents") await page.locator(".sheet .row").first().click();
      await page.locator(".sheet").getByRole("button", { name: agentLabel(kind), exact: true }).click();
      if (mode) await page.getByRole("button", { name: new RegExp(`^${mode.label}`) }).click();
      await page.getByRole("button", { name: `Start ${agentLabel(kind)}`, exact: true }).click();
      await expect(page).toHaveURL(/\/pane\//);
      await expect(page.locator(".sheet")).toHaveCount(0);
      const starts = (await writes(page)).filter(w => w.path === "/api/agents/start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.body).toMatchObject({ kind, mode: mode?.id ?? null, workspaceId: "w1", clientRequestId: expect.any(String) });
      await expect(page.getByRole("tab", { name: "Read", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Screen", exact: true }).click();
      await expect(page.getByRole("region", { name: "Terminal output" })).toBeVisible();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Synthetic agent compatibility check");
      await page.locator(".compose__send").click();
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
      const paneId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
      const prompts = (await writes(page)).filter(w => w.path === `/api/panes/${encodeURIComponent(paneId)}/prompt` || w.path === `/api/panes/${paneId}/prompt`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.body).toMatchObject({ text: "Synthetic agent compatibility check", clientMessageId: expect.any(String) });
    });
  }
}
