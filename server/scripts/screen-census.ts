/**
 * Draws the screens Claude Code and codex show before a conversation, with
 * this computer's installed versions, and compares each with the capture the
 * parsers are tested against (`server/fixtures/startup`). Run it when either
 * agent updates, as the transcript census is run for the Reader:
 *
 *   bun run server/scripts/screen-census.ts [--out <dir>] [situation …]
 *
 * A screen whose card changed (question, labels, how it is answered), that
 * now waits unrecognised, or that is new, is reported, and the run exits 1.
 * Captures are written to `--out` for review; fixtures are never overwritten.
 *
 * Isolated the way CLAUDE.md's live tests are: a named herdr session under a
 * fresh XDG_CONFIG_HOME, stopped with the same root. Agent configuration is
 * scratch too (CLAUDE_CONFIG_DIR, CODEX_HOME, exported in each tab's shell
 * before herdr launches the agent), keys are fake, and no message is ever sent
 * to an agent: nothing here reaches the user's ~/.claude, ~/.codex, herdr
 * configuration or a model. Everything but the captures is removed afterwards.
 *
 * Codex's update offer is drawn only for an install codex recognises (npm,
 * bun, Homebrew, or its standalone layout under CODEX_HOME): a standalone
 * binary run from elsewhere, as on a Mac, shows none, and is reported so.
 * Older agents are checked by putting them first on PATH, in a disposable
 * machine (OrbStack, October 2026): their cards are expected to differ from
 * the fixtures, and what matters is that none of them is "no menu".
 */
import { argsForMode, modesFor } from "@shahi/shared";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrClient } from "../lib/herdr-client";
import { parsePrompt, stripAnsi } from "../lib/prompt-parser";
import { providerWaitingScreen } from "../lib/provider-prompts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "startup");
const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const out = outAt >= 0 ? argv.splice(outAt, 2)[1]! : mkdtempSync("/tmp/shahi-census-out.");
const only = new Set(argv);

/** Fake, and shaped like a key only as far as Claude Code's dialog needs. */
const FAKE_KEY = "sk-fake-key--FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789";

interface Situation {
  id: string;
  kind: "claude" | "codex";
  mode?: string;
  /** Writes the scratch configuration and project folder; returns the shell exports. */
  setup: (home: string, project: string) => string;
  /** Keys pressed once the first screen settles, for a screen behind it. */
  then?: string[];
}

const claudeHome = (home: string, project: string, config: Record<string, unknown>) => {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] }, ...config,
    projects: config.projects ?? { [project]: { hasTrustDialogAccepted: true } } }));
  return `export CLAUDE_CONFIG_DIR=${home} ANTHROPIC_API_KEY=${FAKE_KEY}`;
};
const codexHome = (home: string, project: string, config = "", { signedIn = true, trusted = true } = {}) => {
  writeFileSync(join(home, "config.toml"), `${config}\n${trusted ? `[projects."${project}"]\ntrust_level = "trusted"\n` : ""}`);
  if (signedIn) {
    const login = Bun.spawnSync(["codex", "login", "--with-api-key"], { stdin: new TextEncoder().encode(FAKE_KEY), env: { ...process.env, CODEX_HOME: home } });
    if (login.exitCode !== 0) throw new Error(`codex login into the scratch CODEX_HOME failed: ${login.stderr}`);
  }
  return `export CODEX_HOME=${home}`;
};
const mcp = (project: string, names: string[]) =>
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, { command: "true" }])) }));

const ALL: Situation[] = [
  { id: "claude-theme", kind: "claude", setup: (home) => `export CLAUDE_CONFIG_DIR=${home}; unset ANTHROPIC_API_KEY` },
  { id: "claude-login", kind: "claude", setup: (home) => `export CLAUDE_CONFIG_DIR=${home}; unset ANTHROPIC_API_KEY`, then: ["Enter"] },
  { id: "claude-api-key", kind: "claude", setup: (home, project) => claudeHome(home, project, { customApiKeyResponses: { approved: [], rejected: [] } }) },
  { id: "claude-trust", kind: "claude", setup: (home, project) => claudeHome(home, project, { projects: {} }) },
  { id: "claude-bypass", kind: "claude", mode: "bypass", setup: (home, project) => claudeHome(home, project, {}) },
  { id: "claude-mcp-one", kind: "claude", setup: (home, project) => (mcp(project, ["scratch-one"]), claudeHome(home, project, {})) },
  { id: "claude-mcp-two", kind: "claude", setup: (home, project) => (mcp(project, ["scratch-one", "scratch-two"]), claudeHome(home, project, {})) },
  { id: "claude-imports", kind: "claude", setup: (home, project) => {
    writeFileSync(join(project, "..", "outside.md"), "Scratch import.\n");
    writeFileSync(join(project, "CLAUDE.md"), "@../outside.md\n");
    return claudeHome(home, project, {});
  } },
  { id: "claude-settings-error", kind: "claude", setup: (home, project) => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: 5 } }));
    return claudeHome(home, project, {});
  } },
  { id: "claude-ready", kind: "claude", setup: (home, project) => claudeHome(home, project, {}) },
  { id: "codex-sign-in", kind: "codex", setup: (home, project) => codexHome(home, project, "", { signedIn: false }) },
  { id: "codex-trust", kind: "codex", setup: (home, project) => codexHome(home, project, "", { trusted: false }) },
  { id: "codex-migration", kind: "codex", setup: (home, project) => codexHome(home, project, 'model = "gpt-5.4"') },
  { id: "codex-hooks", kind: "codex", setup: (home, project) => {
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo scratch", timeout: 10 }] }] } }));
    return codexHome(home, project, "[features]\nhooks = true");
  } },
  // Drawn only where codex knows how it was installed (npm, bun, Homebrew,
  // or its standalone layout under CODEX_HOME), and only once a newer release
  // is on record; the record is written here, dated now.
  { id: "codex-update", kind: "codex", setup: (home, project) => {
    writeFileSync(join(home, "version.json"), JSON.stringify({ latest_version: "9.0.0", last_checked_at: new Date().toISOString(), dismissed_version: null }));
    return codexHome(home, project);
  } },
  { id: "codex-ready", kind: "codex", setup: (home, project) => codexHome(home, project) },
];
const SITUATIONS = ALL.filter((situation) => only.size === 0 || only.has(situation.id));

// Short on purpose: a macOS socket address holds 104 bytes (CLAUDE.md, Testing).
const root = mkdtempSync("/tmp/shc.");
const xdg = join(root, "xdg");
// Its own name per run, so two runs on one machine never share a session.
const session = `shahi-census-${root.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
// herdr, and every shell it starts, without this process's own agent and
// herdr context: nested Claude Code refuses to start inside another.
const env = Object.fromEntries(Object.entries({ ...process.env, XDG_CONFIG_HOME: xdg })
  .filter(([key]) => !/^(CLAUDE|HERDR|AI_AGENT|CODEX)/.test(key))) as Record<string, string>;
const server = Bun.spawn(["herdr", "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
const sleep = (ms: number) => Bun.sleep(ms);
const client = new HerdrClient({ socketPath: join(xdg, "herdr", "sessions", session, "herdr.sock"), timeoutMs: 10_000 });
const rpc = <T = any>(method: string, params: unknown, timeoutMs?: number) =>
  client.rpc(method as never, params as never, timeoutMs ? { timeoutMs } : undefined) as Promise<T>;

const summary = (screen: string) => {
  const parsed = parsePrompt(screen);
  if (parsed) return `card (${parsed.answer}${parsed.confirm ? ", confirm" : ""}) “${parsed.question}”: ${parsed.options.map((o) => o.label).join(" | ")}`;
  return providerWaitingScreen(stripAnsi(screen)) ? "waits, screen shown" : "no menu";
};

async function settle(paneId: string): Promise<string> {
  let last = "";
  let since = Date.now();
  for (const end = Date.now() + 45_000; Date.now() < end; await sleep(500)) {
    const { read } = await rpc("pane.read", { pane_id: paneId, source: "visible", format: "ansi", strip_ansi: false });
    if (read.text !== last) [last, since] = [read.text, Date.now()];
    else if (Date.now() - since >= 3_000) {
      // Claude Code can sit on a blank screen for seconds before its next
      // dialog (Settings Error came about 8s after launch), with herdr saying
      // `unknown` meanwhile; a screen with nothing on it yet is not the answer.
      if (summary(last) !== "no menu") break;
      const { pane } = await rpc("pane.get", { pane_id: paneId });
      if (pane?.agent_status !== "unknown") break;
    }
  }
  return last;
}

let changed = 0;
try {
  for (let tries = 0; ; tries++) {
    try { await client.connect(); break; } catch (err) { if (tries > 40) throw err; await sleep(250); }
  }
  const { workspace } = await rpc("workspace.create", { cwd: root, label: "census", focus: false });
  for (const situation of SITUATIONS) {
    const home = join(root, situation.id, "home");
    const project = join(root, situation.id, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const exports = situation.setup(home, realpathSync(project));
    const { root_pane: { pane_id: paneId }, tab: { tab_id: tabId } } = await rpc("tab.create", { workspace_id: workspace.workspace_id, label: situation.id, cwd: project, focus: false });
    await settle(paneId);
    await rpc("pane.send_text", { pane_id: paneId, text: exports });
    await sleep(200);
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    await settle(paneId);
    const mode = situation.mode ?? modesFor(situation.kind)[0]!.id;
    const args = argsForMode(situation.kind, mode);
    for (let attempt = 0; ; attempt++) {
      try {
        await rpc("agent.start", { pane_id: paneId, kind: situation.kind, name: situation.id, ...(args.length ? { args } : {}) }, 60_000);
        break;
      } catch (err) {
        if (!String(err).includes("agent_pane_busy") || attempt > 20) throw err;
        await sleep(500);
      }
    }
    let screen = await settle(paneId);
    // A key that lands before the screen takes input is dropped (Claude Code
    // refuses one within 150ms of a menu opening), so it is pressed again,
    // but only while the screen has not moved: never twice on the next one.
    for (let tries = 0; situation.then && tries < 3; tries++) {
      await sleep(1_000);
      await rpc("pane.send_keys", { pane_id: paneId, keys: situation.then });
      const next = await settle(paneId);
      if (stripAnsi(next) === stripAnsi(screen)) continue;
      screen = next;
      break;
    }
    const { pane } = await rpc("pane.get", { pane_id: paneId });
    writeFileSync(join(out, `${situation.id}.ansi`), screen);
    let fixture: string | null = null;
    try { fixture = readFileSync(join(FIXTURES, `${situation.id}.ansi`), "utf8"); } catch {}
    const now = summary(screen);
    const before = fixture === null ? null : summary(fixture);
    const same = now === before;
    if (!same) changed++;
    console.log(`${same ? "same   " : before === null ? "NEW    " : "CHANGED"} ${situation.id} (herdr: ${pane?.agent_status ?? "?"})\n        now:     ${now}${same ? "" : `\n        fixture: ${before ?? "none"}`}`);
    // Two Ctrl-C leave any of these screens; the tab goes with whatever is left.
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["C-c"] }).catch(() => {});
    await sleep(600);
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["C-c"] }).catch(() => {});
    await sleep(600);
    await rpc("tab.close", { tab_id: tabId }).catch(() => {});
  }
} finally {
  Bun.spawnSync(["herdr", "session", "stop", session], { env });
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nCaptures in ${out}. ${changed ? `${changed} screen(s) differ from server/fixtures/startup: review, then update the fixture and its parser together.` : "Every screen matches its fixture."}`);
process.exit(changed ? 1 : 0);
