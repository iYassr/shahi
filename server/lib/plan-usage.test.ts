/**
 * Plan usage: Codex's limits read from its rollouts, and the Claude Code
 * status line that records Claude's, installed and removed without losing the
 * person's own. Shapes are the measured ones (Codex 0.157.1 `token_count`,
 * Claude Code 2.1.286 status line input), with invented numbers.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSettingsError, codexUsage, planUsage, refreshClaudeStatusLine, setClaudePlanUsage, type PlanUsagePaths } from "./plan-usage";

const root = mkdtempSync(join(tmpdir(), "shahi-plan-usage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const paths: PlanUsagePaths = { dataDir: join(root, "data"), bun: process.execPath, claudeDir: join(root, "claude"), codexHome: join(root, "codex") };
const settingsFile = join(root, "claude", "settings.json");
const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"));

beforeEach(() => {
  for (const dir of ["data", "claude", "codex"]) { rmSync(join(root, dir), { recursive: true, force: true }); mkdirSync(join(root, dir), { recursive: true }); }
});

describe("Codex", () => {
  const tokenCount = (at: string, primary: number, secondary: number | null) => JSON.stringify({
    timestamp: at, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: 10 } }, rate_limits: {
      limit_id: "codex", primary: { used_percent: primary, window_minutes: 300, resets_at: 1_790_000_000 },
      secondary: secondary === null ? null : { used_percent: secondary, window_minutes: 10_080, resets_at: 1_790_500_000 },
      credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "plus" } },
  });
  const rollout = (day: string, name: string, rows: string[], ageSeconds: number) => {
    const dir = join(root, "codex", "sessions", "2026", "10", day);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-${day}T10-00-00-${name}.jsonl`);
    writeFileSync(file, rows.join("\n") + "\n");
    const at = Date.now() / 1000 - ageSeconds;
    utimesSync(file, at, at);
  };

  test("the newest reading across recent rollouts is the account's", async () => {
    rollout("01", "older", [tokenCount("2026-10-01T09:00:00Z", 80, 40)], 3_600);
    rollout("01", "newer", [tokenCount("2026-10-01T10:00:00Z", 12, 31), JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: null } })], 60);
    expect(await codexUsage(paths.codexHome)).toEqual({
      observedAt: Date.parse("2026-10-01T10:00:00Z"), plan: "plus",
      windows: [{ label: "5-hour", usedPercent: 12, resetsAt: 1_790_000_000_000 }, { label: "Weekly", usedPercent: 31, resetsAt: 1_790_500_000_000 }],
    });
  });

  test("a newest conversation with no turn yet does not hide an older reading", async () => {
    rollout("02", "fresh", [JSON.stringify({ type: "session_meta", payload: {} })], 10);
    rollout("01", "worked", [tokenCount("2026-10-01T10:00:00Z", 5, null)], 600);
    expect((await codexUsage(paths.codexHome))?.windows).toEqual([{ label: "5-hour", usedPercent: 5, resetsAt: 1_790_000_000_000 }]);
  });

  test("an older rollout that says how long is left still gives a reset time", async () => {
    rollout("01", "legacy", [JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 50, window_minutes: 300, resets_in_seconds: 600 } } } })], 60);
    expect((await codexUsage(paths.codexHome))?.windows[0]?.resetsAt).toBe(Date.parse("2026-10-01T10:00:00Z") + 600_000);
  });

  test("no Codex, or no reading, is nothing rather than zero", async () => {
    expect(await codexUsage(join(root, "missing"))).toBeNull();
    rollout("01", "quiet", ["not json", JSON.stringify({ type: "turn_context" })], 60);
    expect(await codexUsage(paths.codexHome)).toBeNull();
  });
});

describe("Claude Code", () => {
  const statusInput = JSON.stringify({
    session_id: "s", transcript_path: "/Users/me/.claude/projects/p/s.jsonl", cwd: "/Users/me/work", model: { display_name: "Opus" },
    cost: { total_cost_usd: 1.2 }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_790_000_000 }, seven_day: { used_percentage: 41.2, resets_at: 1_790_500_000 } },
  });
  const runStatusLine = () => {
    const command = settings().statusLine.command as string;
    return Bun.spawnSync(["/bin/sh", "-c", command], { stdin: new TextEncoder().encode(statusInput) });
  };

  test("turning it on keeps the person's settings and status line, and records only the limits", async () => {
    writeFileSync(settingsFile, JSON.stringify({ model: "opus", statusLine: { type: "command", command: "echo mine", padding: 1 } }, null, 2));
    await setClaudePlanUsage(paths, true);
    expect(settings()).toMatchObject({ model: "opus", statusLine: { type: "command", padding: 1 } });
    expect(settings().statusLine.command).toContain("claude-statusline.mjs");

    const run = runStatusLine();
    expect(run.stdout.toString().trim()).toBe("mine");
    const recorded = JSON.parse(readFileSync(join(root, "data", "claude-plan-usage.json"), "utf8"));
    expect(Object.keys(recorded).sort()).toEqual(["five_hour", "observedAt", "seven_day"]);
    expect(JSON.stringify(recorded)).not.toContain("/Users/me");

    const usage = await planUsage(paths);
    expect(usage.claude).toEqual({ enabled: true, usage: { observedAt: recorded.observedAt, windows: [
      { label: "5-hour", usedPercent: 23.5, resetsAt: 1_790_000_000_000 }, { label: "Weekly", usedPercent: 41.2, resetsAt: 1_790_500_000_000 },
    ] } });
  });

  test("turning it off puts the person's status line back and forgets the readings", async () => {
    const theirs = { type: "command", command: "echo mine", padding: 1 };
    writeFileSync(settingsFile, JSON.stringify({ model: "opus", statusLine: theirs }));
    await setClaudePlanUsage(paths, true);
    runStatusLine();
    await setClaudePlanUsage(paths, false);
    expect(settings()).toEqual({ model: "opus", statusLine: theirs });
    expect(existsSync(join(root, "data", "claude-plan-usage.json"))).toBe(false);
    expect((await planUsage(paths)).claude).toEqual({ enabled: false, usage: null });
  });

  test("with no settings file or status line before, on writes one and off removes only the status line", async () => {
    await setClaudePlanUsage(paths, true);
    expect(runStatusLine().stdout.toString()).toBe("");
    await setClaudePlanUsage(paths, false);
    expect(settings()).toEqual({});
  });

  test("a status line someone set after Shahi's is left alone when Shahi's is turned off", async () => {
    await setClaudePlanUsage(paths, true);
    writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: "command", command: "echo later" } }));
    await setClaudePlanUsage(paths, false);
    expect(settings()).toEqual({ statusLine: { type: "command", command: "echo later" } });
    expect((await planUsage(paths)).claude.enabled).toBe(false);
  });

  test("settings that do not parse are never rewritten", async () => {
    writeFileSync(settingsFile, "{ // a comment Claude Code would refuse too\n}");
    await expect(setClaudePlanUsage(paths, true)).rejects.toBeInstanceOf(ClaudeSettingsError);
    expect(readFileSync(settingsFile, "utf8")).toBe("{ // a comment Claude Code would refuse too\n}");
  });

  test("after an update moves Bun, the installed command follows it", async () => {
    await setClaudePlanUsage(paths, true);
    const moved = { ...paths, bun: "/opt/new bun/bin/bun" };
    await refreshClaudeStatusLine(moved);
    expect(settings().statusLine.command).toBe(`'/opt/new bun/bin/bun' '${join(root, "data", "claude-statusline.mjs")}'`);
    rmSync(settingsFile);
    await refreshClaudeStatusLine(paths);
    expect(existsSync(settingsFile)).toBe(false);
  });
});
