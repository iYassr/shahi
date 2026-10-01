/**
 * How much of each agent's subscription is used: the 5-hour and weekly
 * windows Claude Code shows in `/usage` and Codex in `/status`.
 *
 * Codex writes its limits into the conversation it is running: every
 * `token_count` event in a rollout carries `rate_limits` (primary and
 * secondary windows, `used_percent`, `window_minutes`, `resets_at` in epoch
 * seconds), measured on 0.157.1. The newest one on disk is the account's.
 *
 * Claude Code writes its limits nowhere on disk; `/usage` asks Anthropic with
 * the person's sign-in each time. Its documented status line input carries
 * them (`rate_limits.five_hour` and `.seven_day`, `used_percentage` and
 * `resets_at` in epoch seconds, for Pro and Max), so plan usage for Claude is a
 * status line Shahi installs when the person turns it on in Settings: a script
 * that saves those numbers and then runs whatever status line was there
 * before. Turning it off puts the previous one back. A status line costs
 * Claude Code's footer hints (`esc to interrupt`, `? for shortcuts`), which is
 * why it is the person's choice. herdr's working, waiting and done states were
 * measured identical with and without one (Claude Code 2.1.286, herdr 0.9.1,
 * October 2026).
 */
import type { PlanUsage, PlanWindow, ProviderUsage } from "@shahi/shared";
import { planWindowLabel } from "@shahi/shared";
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir } from "./session-log";

/** Enough of a rollout's end to hold its last turn's token count. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;
/** Rollouts looked at, newest first: an idle newest one may hold no turn yet. */
const ROLLOUTS_CHECKED = 6;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface PlanUsagePaths {
  /** Shahi's data directory: the status line script and what it records live here. */
  dataDir: string;
  /** The Bun that runs the status line script. */
  bun: string;
  claudeDir?: string;
  codexHome?: string;
}

export async function planUsage(paths: PlanUsagePaths, now = Date.now()): Promise<PlanUsage> {
  const [claude, enabled, codex] = await Promise.all([claudeUsage(paths), claudeEnabled(paths), codexUsage(paths.codexHome)]);
  return { claude: { enabled, usage: enabled ? claude : null }, codex: { usage: codex }, checkedAt: now };
}

/* ------------------------------------------------------------------ Codex -- */

function codexWindow(raw: unknown, observedAt: number): PlanWindow | null {
  if (!isRecord(raw) || !finite(raw.used_percent)) return null;
  const minutes = finite(raw.window_minutes) ? raw.window_minutes : null;
  // Older rollouts said how long was left rather than when.
  const resetsAt = finite(raw.resets_at) ? raw.resets_at * 1000 : finite(raw.resets_in_seconds) ? observedAt + raw.resets_in_seconds * 1000 : null;
  return { label: planWindowLabel(minutes), usedPercent: raw.used_percent, resetsAt };
}

/** The last rate-limit reading in one rollout's tail, if it has one. */
async function lastReading(path: string): Promise<ProviderUsage | null> {
  let text: string;
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, ROLLOUT_TAIL_BYTES);
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, size - length);
      text = bytes.toString("utf8");
    } finally { await file.close(); }
  } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; } // the first line can be cut
    if (!isRecord(row) || row.type !== "event_msg" || !isRecord(row.payload) || row.payload.type !== "token_count") continue;
    const limits = row.payload.rate_limits;
    if (!isRecord(limits)) continue;
    const observedAt = Date.parse(String(row.timestamp)) || 0;
    const windows = [codexWindow(limits.primary, observedAt), codexWindow(limits.secondary, observedAt)].filter((w): w is PlanWindow => w !== null);
    if (!windows.length) continue;
    return { observedAt, windows, ...(typeof limits.plan_type === "string" && limits.plan_type ? { plan: limits.plan_type } : {}) };
  }
  return null;
}

/** The newest rollouts, found by walking the dated folders newest first rather than listing them all. */
async function newestRollouts(sessions: string): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  const names = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  for (const year of (await names(sessions)).filter((n) => /^\d{4}$/.test(n))) {
    for (const month of (await names(join(sessions, year))).filter((n) => /^\d{2}$/.test(n))) {
      for (const day of (await names(join(sessions, year, month))).filter((n) => /^\d{2}$/.test(n))) {
        const dir = join(sessions, year, month, day);
        for (const name of await names(dir)) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const info = await stat(join(dir, name)).catch(() => null);
          if (info?.isFile()) found.push({ path: join(dir, name), mtime: info.mtimeMs });
        }
        // Folders are dated by when a conversation began, and an old one can
        // still be running, so a day's worth beyond the first few is kept.
        if (found.length >= ROLLOUTS_CHECKED * 2) return found.sort((a, b) => b.mtime - a.mtime).slice(0, ROLLOUTS_CHECKED).map((f) => f.path);
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, ROLLOUTS_CHECKED).map((f) => f.path);
}

export async function codexUsage(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<ProviderUsage | null> {
  const readings = await Promise.all((await newestRollouts(join(codexHome, "sessions"))).map(lastReading));
  return readings.filter((r): r is ProviderUsage => r !== null).sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
}

/* ----------------------------------------------------------------- Claude -- */

const scriptPath = (paths: PlanUsagePaths) => join(paths.dataDir, "claude-statusline.mjs");
const recordPath = (paths: PlanUsagePaths) => join(paths.dataDir, "claude-plan-usage.json");
const statePath = (paths: PlanUsagePaths) => join(paths.dataDir, "claude-statusline.json");
const settingsPath = (paths: PlanUsagePaths) => join(paths.claudeDir ?? claudeConfigDir(), "settings.json");
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ourCommand = (paths: PlanUsagePaths) => `${shellQuote(paths.bun)} ${shellQuote(scriptPath(paths))}`;

/** Claude Code's settings, or null when the file is missing; a file that does not parse is never rewritten. */
async function readSettings(paths: PlanUsagePaths): Promise<Record<string, unknown> | null> {
  let text: string;
  try { text = await readFile(settingsPath(paths), "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const settings: unknown = JSON.parse(text);
  if (!isRecord(settings)) throw new Error("not an object");
  return settings;
}

async function writeAtomically(path: string, text: string, mode: number) {
  const temp = `${path}.shahi-${process.pid}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}

const isOurs = (statusLine: unknown, paths: PlanUsagePaths) =>
  isRecord(statusLine) && typeof statusLine.command === "string" && statusLine.command.includes(scriptPath(paths));

export async function claudeEnabled(paths: PlanUsagePaths): Promise<boolean> {
  try { return isOurs((await readSettings(paths))?.statusLine, paths); } catch { return false; }
}

/**
 * The script Claude Code runs as its status line. It keeps only the limits and
 * the time, never the rest of the input (paths, cost, model), and runs the
 * previous status line with the same input so its output is still shown.
 */
function script(paths: PlanUsagePaths, previous: string | null): string {
  return `// Written by Shahi (Settings, Agents, Claude Code). It saves Claude Code's plan
// usage for Shahi, then runs the status line configured before it, if any.
// Turning plan usage off in Shahi puts that status line back.
import { renameSync, writeFileSync } from "node:fs";
const record = ${JSON.stringify(recordPath(paths))};
const previous = ${JSON.stringify(previous)};
const input = await Bun.stdin.text();
try {
  const limits = JSON.parse(input).rate_limits;
  const pick = (w) => w && Number.isFinite(w.used_percentage) && Number.isFinite(w.resets_at) ? { used_percentage: w.used_percentage, resets_at: w.resets_at } : undefined;
  if (limits && typeof limits === "object") {
    const temp = record + "." + process.pid + ".tmp";
    writeFileSync(temp, JSON.stringify({ observedAt: Date.now(), five_hour: pick(limits.five_hour), seven_day: pick(limits.seven_day), spend_limit: pick(limits.spend_limit) }), { mode: 0o600 });
    renameSync(temp, record);
  }
} catch {}
if (previous) await Bun.spawn(["/bin/sh", "-c", previous], { stdin: new TextEncoder().encode(input), stdout: "inherit", stderr: "inherit" }).exited;
`;
}

export class ClaudeSettingsError extends Error {}

/** Turns Claude's plan usage on or off by installing or removing Shahi's status line. */
export async function setClaudePlanUsage(paths: PlanUsagePaths, enabled: boolean): Promise<void> {
  let settings: Record<string, unknown> | null;
  try { settings = await readSettings(paths); } catch {
    throw new ClaudeSettingsError("Claude Code's settings.json could not be read, so it was left unchanged.");
  }
  const current = settings?.statusLine;
  const mode = (await stat(settingsPath(paths)).catch(() => null))?.mode ?? 0o600;
  if (enabled) {
    if (isOurs(current, paths)) { await refreshClaudeStatusLine(paths); return; }
    const previous = isRecord(current) ? current : null;
    await writeAtomically(statePath(paths), JSON.stringify({ previous }), 0o600);
    await writeAtomically(scriptPath(paths), script(paths, previous?.type === "command" && typeof previous.command === "string" ? previous.command : null), 0o600);
    const statusLine = { type: "command", command: ourCommand(paths),
      ...(previous && "padding" in previous ? { padding: previous.padding } : {}),
      ...(previous && "refreshInterval" in previous ? { refreshInterval: previous.refreshInterval } : {}) };
    await writeAtomically(settingsPath(paths), `${JSON.stringify({ ...(settings ?? {}), statusLine }, null, 2)}\n`, mode & 0o777);
    return;
  }
  if (isOurs(current, paths) && settings) {
    let previous: unknown = null;
    try { previous = (JSON.parse(await readFile(statePath(paths), "utf8")) as { previous?: unknown }).previous ?? null; } catch {}
    const { statusLine: _ours, ...rest } = settings;
    await writeAtomically(settingsPath(paths), `${JSON.stringify(isRecord(previous) ? { ...rest, statusLine: previous } : rest, null, 2)}\n`, mode & 0o777);
  }
  // Someone else's status line now: theirs stays, and Shahi forgets its own.
  await Promise.all([statePath(paths), scriptPath(paths), recordPath(paths)].map((p) => rm(p, { force: true })));
}

/**
 * Keeps an installed status line pointing at this Bun and this script's
 * current text, after an update moved either. Does nothing when it is off.
 */
export async function refreshClaudeStatusLine(paths: PlanUsagePaths): Promise<void> {
  let settings: Record<string, unknown> | null;
  try { settings = await readSettings(paths); } catch { return; }
  if (!settings || !isOurs(settings.statusLine, paths)) return;
  let previous: unknown = null;
  try { previous = (JSON.parse(await readFile(statePath(paths), "utf8")) as { previous?: unknown }).previous ?? null; } catch {}
  const command = isRecord(previous) && previous.type === "command" && typeof previous.command === "string" ? previous.command : null;
  await writeAtomically(scriptPath(paths), script(paths, command), 0o600);
  const statusLine = settings.statusLine as Record<string, unknown>;
  if (statusLine.command !== ourCommand(paths)) {
    const mode = (await stat(settingsPath(paths)).catch(() => null))?.mode ?? 0o600;
    await writeAtomically(settingsPath(paths), `${JSON.stringify({ ...settings, statusLine: { ...statusLine, command: ourCommand(paths) } }, null, 2)}\n`, mode & 0o777);
  }
}

const CLAUDE_WINDOWS: [key: string, label: string][] = [["five_hour", "5-hour"], ["seven_day", "Weekly"], ["spend_limit", "Spend limit"]];

async function claudeUsage(paths: PlanUsagePaths): Promise<ProviderUsage | null> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(recordPath(paths), "utf8")); } catch { return null; }
  if (!isRecord(raw) || !finite(raw.observedAt)) return null;
  const windows = CLAUDE_WINDOWS.flatMap(([key, label]) => {
    const w = raw[key];
    return isRecord(w) && finite(w.used_percentage) ? [{ label, usedPercent: w.used_percentage, resetsAt: finite(w.resets_at) ? w.resets_at * 1000 : null }] : [];
  });
  return windows.length ? { observedAt: raw.observedAt, windows } : null;
}
