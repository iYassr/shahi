/**
 * Starts real agents the two ways people start them and checks the phone sees
 * each conversation, through the functions its routes call:
 *
 *   bun run server/scripts/agent-journeys.ts [claude] [codex] [cursor] [opencode] [agy]
 *     [shahi] [hand] [--out <dir>]
 *
 * For each installed agent: started by Shahi (`startAgentInTab`, as New agent
 * does) and started by hand (its plain command typed into a shell). A short
 * message goes in through `submitPrompt`, and once the reply is in the
 * transcript the run checks, every 5 s for a minute, that Reader finds the
 * conversation, that its page holds the reply, that the agent list's preview
 * does, and that Read agrees with Screen. Each agent is then asked to run a
 * command: if it asks first, the question must be one the phone can answer (a
 * card with a yes, as the poller would offer it) while Reader still finds the
 * conversation, the answer is given through `answerPrompt`, and the command
 * must run. Exits 1 if any journey fails.
 * With `--out`, a journey that fails on a screen writes that screen there, for
 * review; nothing else in the run prints or keeps what the panes showed.
 *
 * Why it exists: each Reader failure of October 2026 passed every test. Codex
 * 0.160 started by hand reported no session and held no file open (TestFlight
 * build 39). The fix then found nothing on a Mac whenever Codex had its index
 * closed. Both were invisible to fixtures and to agents started by Shahi, and
 * the second came and went within a minute. Run this when claude, codex or herdr
 * updates, before a computer release, and on each computer after installing one.
 *
 * Isolated as CLAUDE.md's live tests are: a named herdr session under a fresh
 * XDG_CONFIG_HOME, stopped and removed afterwards. The agents are real and
 * signed in as this computer's user, so each journey costs one short reply on
 * that account. They work in a folder of their own under /tmp/shahi-journeys,
 * a scratch git repository whose trust question is answered here. Claude's
 * transcripts for that folder are removed after the run; the other agents'
 * conversations stay in their histories under that folder. Nothing prints
 * conversation text: the reply is a token, checked by comparison only.
 *
 * Cursor, OpenCode and Antigravity were added after their own updates had
 * gone untested for weeks (October 2026): Antigravity 1.4.1 redrew the edit
 * approval its card is matched against, and only Claude and Codex ran here.
 */
import { agentCommand } from "@shahi/shared";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAgentInTab } from "../lib/agents";
import { herdrCompatibility } from "../lib/backend";
import { answerPrompt } from "../lib/answer";
import { conversationSummary, transcriptPage, transcriptSourceFor } from "../lib/conversation-summary";
import { HerdrClient } from "../lib/herdr-client";
import { openReadOnly } from "../lib/foreign-sqlite";
import { submitPrompt, promptTarget } from "../lib/prompt";
import { parsePrompt } from "../lib/prompt-parser";
import { providerIsWaiting } from "../lib/provider-prompts";
import { compare, disagreement } from "../lib/reader-parity";
import { SessionStore } from "../lib/state";

const KINDS = ["claude", "codex", "cursor", "opencode", "agy"] as const;
type Kind = (typeof KINDS)[number];
type Launch = "shahi" | "hand";
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const argv = new Set(args);
const kinds = KINDS.filter((kind) => !KINDS.some((k) => argv.has(k)) || argv.has(kind));
const launches = (["shahi", "hand"] as Launch[]).filter((launch) => (!argv.has("shahi") && !argv.has("hand")) || argv.has(launch));
const STEADY_MS = 60_000;
// One journey's worst case is about seven minutes; one that runs past ten is
// stuck, and the next must still run.
const JOURNEY_MS = 10 * 60_000;
const ASK = "Reply with exactly the word";

// herdr, and every shell it starts, without this process's own agent and herdr
// context: nested Claude Code refuses to start inside another.
const root = mkdtempSync("/tmp/shj."); // short: a macOS socket address holds 104 bytes
const xdg = join(root, "xdg");
const session = `shahi-journeys-${root.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
const env = Object.fromEntries(Object.entries({ ...process.env, XDG_CONFIG_HOME: xdg })
  .filter(([key]) => !/^(CLAUDE|HERDR|AI_AGENT|CODEX)/.test(key))) as Record<string, string>;
// The panes inherit that XDG_CONFIG_HOME, and OpenCode and Cursor keep their
// own configuration there, herdr's integrations included: an OpenCode with an
// empty one loaded no session reporter and never named its conversation, so
// the journey failed on something no real computer has (20 October 2026).
// They get theirs back; herdr keeps the scratch one, so no plugin of the
// person's runs here.
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
mkdirSync(xdg);
for (const name of ["opencode", "cursor"]) {
  if (existsSync(join(configHome, name))) symlinkSync(join(configHome, name), join(xdg, name));
}

// One repository for every run, so its trust is asked once rather than written
// again for each run's folder; a folder per run inside it, so Codex never sees
// two threads of one name in one folder (its title lookup refuses those).
const repo = "/tmp/shahi-journeys";
mkdirSync(repo, { recursive: true });
if (!existsSync(join(repo, ".git"))) Bun.spawnSync(["git", "init", "--quiet", repo]);
const nonce = Math.random().toString(36).slice(2, 8);
const runDir = join(realpathSync(repo), `run-${nonce}`);
mkdirSync(runDir);
// And a folder per journey within it: Codex names threads from their first
// message, so both Codex journeys' threads were "Reply with exact word", and
// two threads of one name in one folder are refused (ubuntu, 2026-10-04).
const folderOf = (kind: Kind, launch: Launch) => join(runDir, `${kind}-${launch}`);

const server = Bun.spawn(["herdr", "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
const client = new HerdrClient({ socketPath: join(xdg, "herdr", "sessions", session, "herdr.sock"), timeoutMs: 10_000 });
const rpc = <T = any>(method: string, params: unknown, options?: { timeoutMs?: number }) =>
  client.rpc(method as never, params as never, options) as Promise<T>;
const store = new SessionStore(client);
const visible = async (paneId: string) => (await rpc("pane.read", { pane_id: paneId, source: "visible", format: "text", strip_ansi: true })).read.text as string;
const status = async (paneId: string) => (await rpc("pane.get", { pane_id: paneId })).pane?.agent_status as string | undefined;

/**
 * The journey could not test Shahi: the agent's own account stopped it. Said
 * as a skip, so the hourly runner files no issue for a sign-in or a provider
 * bill, which no change to Shahi can fix.
 */
class Untestable extends Error {}

/**
 * Waits until the agent takes a message, answering only what a scratch folder
 * makes safe: trusting it, and skipping Codex's update offer. Anything else
 * that asks (sign-in, hooks review, a model change, terms) is the person's,
 * and fails the journey with its question.
 */
async function ready(paneId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let answered = 0;
  while (Date.now() < deadline) {
    await Bun.sleep(1_500);
    const now = await status(paneId);
    const asked = parsePrompt(await visible(paneId));
    if (asked) {
      const safe = asked.options.find((option) => /trust|^yes, continue|^skip/i.test(option.label));
      if (!safe || answered > 4) throw new Error(`waits on "${asked.question}", which needs a person`);
      await answerPrompt(rpc as never, paneId, safe);
      answered++;
      continue;
    }
    if (now === "idle" || now === "done") {
      // herdr calls an agent at its sign-in screen idle: Cursor 2026.10 with
      // an expired login drew "Press any key to log in..." and the journey
      // went on to type into it (ubuntu, 20 October 2026).
      if (/press any key to (log|sign) ?in/i.test(await visible(paneId))) throw new Untestable("is not signed in on this computer, which needs a person");
      return;
    }
  }
  throw new Error(`was not ready within 2 minutes (herdr says ${await status(paneId)})`);
}

/**
 * The herdr pane that owns the person's shared Codex daemon, if its herdr is
 * still running. A Codex started by hand joins that daemon, which runs every
 * thread's SessionStart hook with the herdr variables of the pane that
 * started it (codex-cli 0.163, reproduced in a scratch session and CODEX_HOME
 * on 23 October 2026: pane B's thread was reported as pane A's). On 17 October
 * a hand-started journey's thread was reported as the person's spendings
 * pane; herdr resumed it there after a restart, and Reader and Screen both
 * showed the journey in place of the person's conversation. A daemon whose
 * herdr has gone reports nowhere, so the journey runs then, and when no daemon
 * runs at all it starts one under its own session, which ends with it. There
 * is one daemon per CODEX_HOME, and the journey's Codex joins only the one of
 * its own: a scratch daemon for another CODEX_HOME made it skip for nothing
 * (27 October 2026).
 */
function liveCodexDaemonOwner(own: string): string | null {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  for (const line of ps.split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (!pid || !/codex/.test(command.join(" ")) || !command.includes("app-server")) continue;
    const env = existsSync(`/proc/${pid}/environ`)
      ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
      : Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", pid]).stdout.toString().split(/\s+/);
    const socket = env.find((entry) => entry.startsWith("HERDR_SOCKET_PATH="))?.slice("HERDR_SOCKET_PATH=".length);
    const pane = env.find((entry) => entry.startsWith("HERDR_PANE_ID="))?.slice("HERDR_PANE_ID=".length);
    const home = env.find((entry) => entry.startsWith("CODEX_HOME="))?.slice("CODEX_HOME=".length) || join(homedir(), ".codex");
    if (home !== codexHome) continue;
    if (socket && pane && socket !== own && existsSync(socket)) return `${pane} (${socket})`;
  }
  return null;
}

async function start(kind: Kind, launch: Launch, workspaceId: string): Promise<string> {
  const cwd = folderOf(kind, launch);
  mkdirSync(cwd);
  if (launch === "shahi") {
    const { paneId } = await startAgentInTab(rpc, { workspaceId, cwd, label: `${kind}-shahi`, kind, name: `${kind}-shahi-${nonce}` });
    return paneId;
  }
  const { root_pane: { pane_id: paneId } } = await rpc("tab.create", { workspace_id: workspaceId, label: `${kind}-hand`, cwd, focus: false });
  await Bun.sleep(2_000); // the shell's first prompt
  await rpc("pane.send_text", { pane_id: paneId, text: agentCommand(kind) });
  await Bun.sleep(200);
  await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  return paneId;
}

interface Look { found: boolean; reply: boolean; preview: boolean; parity: string | null; last?: string }
async function look(paneId: string, token: string): Promise<Look> {
  await store.resync();
  const pane = store.pane(paneId);
  if (!pane?.agent) return { found: false, reply: false, preview: false, parity: "herdr names no agent in the pane" };
  const source = await transcriptSourceFor(pane, client);
  const page = source ? await transcriptPage(paneId, source, pane.agent, { limit: 60 }) : null;
  // The message sent holds the token too, so only the agent's own words count.
  const reply = !!page?.log.messages.some((message) => message.role === "agent" && JSON.stringify(message.blocks).includes(token));
  const shown = (await conversationSummary(pane, client)).preview ?? "";
  const preview = shown.includes(token) && !shown.includes(ASK);
  const parity = page ? disagreement(compare(await visible(paneId), pane.agent, page.log)) : "no transcript";
  // Who spoke last, for a failure: a conversation ending in a system note is
  // usually the agent's account or provider refusing ("Invalid credentials"
  // from OpenCode on this Mac, October 2026), not Reader losing the reply.
  return { found: !!source, reply, preview, parity, last: page?.log.messages.at(-1)?.role };
}

/** What Reader had to go on, for a failure: herdr's view and the title, never conversation text. */
async function signals(paneId: string, token: string, folder: string): Promise<string> {
  const { pane } = await rpc("pane.get", { pane_id: paneId });
  const title: string = pane?.terminal_title_stripped ?? pane?.terminal_title ?? "";
  const facts = [
    `herdr sees ${pane?.agent ?? "no agent"} (${pane?.agent_status ?? "?"}), session ${pane?.agent_session ? "reported" : "not reported"}`,
    `title "${title}"`,
    `reply on Screen: ${(await visible(paneId)).includes(token) ? "yes" : "no"}`,
  ];
  const at = title.lastIndexOf(" | ");
  if (pane?.agent === "codex" && at > 0) {
    try {
      const db = openReadOnly(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "state_5.sqlite"));
      try {
        const rows = db.query("SELECT cwd FROM threads WHERE name = ? AND archived = 0").all(title.slice(0, at).trim()) as { cwd: string }[];
        facts.push(`Codex threads with that name: ${rows.length}, in this folder: ${rows.filter((row) => row.cwd === folder).length}`);
      } finally { db.close(); }
    } catch (err) { facts.push(`Codex index unreadable: ${(err as { code?: string }).code ?? err}`); }
  }
  return facts.join("; ");
}

/** Keeps a screen a journey failed on, when asked to; never printed. */
function keep(name: string, screen: string): string {
  if (!out) return "";
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = join(out, `${name}.ansi`);
  writeFileSync(file, screen, { mode: 0o600 });
  return ` (screen kept in ${file})`;
}

/**
 * Asks the agent to run a command, and answers its question as the phone
 * would: only once the poller would offer the card, and only with a plain
 * yes for this one command. A blocked agent whose screen holds no menu the
 * parser knows is the failure this exists for: the phone would show only the
 * terminal, with nothing to tap.
 */
async function permission(kind: Kind, paneId: string, folder: string, token: string): Promise<string[]> {
  const file = join(folder, `${token}.txt`);
  const target = await promptTarget(rpc as never, paneId, store.agent(paneId));
  await submitPrompt(rpc as never, target, `Run the shell command \`touch ${token}.txt\` in the current folder, then reply with the single word done.`);
  const deadline = Date.now() + 180_000;
  let asked = 0;
  let unrecognisedSince = 0;
  while (Date.now() < deadline) {
    await Bun.sleep(1_500);
    if (existsSync(file)) return [];
    const screen = (await rpc("pane.read", { pane_id: paneId, source: "visible", format: "ansi", strip_ansi: false })).read.text as string;
    const now = await status(paneId);
    const parsed = parsePrompt(screen);
    const offered = parsed !== null && (now !== "working" || providerIsWaiting(kind, screen, parsed));
    if (offered) {
      unrecognisedSince = 0;
      const yes = parsed.options.find((option) => /^(yes|allow|approve|accept|run)\b/i.test(option.label) && !/always|don.t ask|session|all\b/i.test(option.label));
      if (!yes) return [`asked "${parsed.question}" with no plain yes among ${parsed.options.length} choices${keep(`${kind}-permission`, screen)}`];
      if (++asked > 3) return [`asked again after ${asked - 1} answers${keep(`${kind}-permission`, screen)}`];
      // The conversation must stay readable while it asks: Codex 0.163 puts
      // "[ ! ] Action Required" in its title then, and Reader, which names a
      // hand-started Codex's thread from that title, lost it until answered.
      if (!(await look(paneId, token)).found) return [`Reader lost the conversation while the agent asked (${await signals(paneId, token, folder)})`];
      await answerPrompt(rpc as never, paneId, { index: yes.index, label: yes.label, question: parsed.question, context: parsed.context });
      continue;
    }
    if (parsed === null && now === "blocked") {
      unrecognisedSince ||= Date.now();
      if (Date.now() - unrecognisedSince > 6_000) return [`waits (herdr: blocked) on a screen with no menu Shahi recognises${keep(`${kind}-permission`, screen)}`];
    } else unrecognisedSince = 0;
  }
  return [`the command did not run within 3 minutes (asked ${asked} time(s); herdr says ${await status(paneId)})`];
}

async function journey(kind: Kind, launch: Launch, workspaceId: string): Promise<string[]> {
  const failures: string[] = [];
  const token = `shahi-${kind}-${launch}-${nonce}`;
  const paneId = await start(kind, launch, workspaceId);
  try {
    await ready(paneId);
    await store.resync();
    const target = await promptTarget(rpc as never, paneId, store.agent(paneId));
    await submitPrompt(rpc as never, target, `${ASK} ${token} and nothing else.`);
    // The reply, as Reader would show it, within three minutes.
    const deadline = Date.now() + 180_000;
    let seen = await look(paneId, token);
    while (!seen.reply && Date.now() < deadline) { await Bun.sleep(3_000); seen = await look(paneId, token); }
    // Reader found the conversation and drew the agent's error in it: the
    // provider refused (OpenCode's "Invalid credentials", a suspended account).
    if (!seen.reply && seen.found && seen.last === "system") throw new Untestable("did not reply: its conversation ends in a system note, as when its account or provider refuses");
    if (!seen.reply) failures.push(`${seen.found ? `Reader found a conversation without the reply, ending in a ${seen.last ?? "missing"} message` : "Reader found no conversation"} (${await signals(paneId, token, folderOf(kind, launch))})`);
    else {
      // Then a minute of looking again: the macOS index failure came and went.
      for (const end = Date.now() + STEADY_MS; Date.now() < end && failures.length === 0; await Bun.sleep(5_000)) {
        const again = await look(paneId, token);
        if (!again.found) failures.push(`Reader lost the conversation after ${Math.round((STEADY_MS - (end - Date.now())) / 1000)} s (${await signals(paneId, token, folderOf(kind, launch))})`);
        else if (!again.reply) failures.push("Reader's page lost the reply");
        else if (!again.preview) failures.push(`the agent list showed no preview after ${Math.round((STEADY_MS - (end - Date.now())) / 1000)} s`);
        else if (again.parity) failures.push(`Read and Screen disagree: ${again.parity}`);
      }
      // Started by hand it runs in the person's own mode, which may never ask
      // (Codex in YOLO mode on this Mac); the command must run either way.
      if (failures.length === 0) failures.push(...(await permission(kind, paneId, folderOf(kind, launch), token)));
    }
  } finally {
    // Two Ctrl-C leave most agents; the tab goes with whatever is left.
    for (let i = 0; i < 2; i++) { await rpc("pane.send_keys", { pane_id: paneId, keys: ["C-c"] }).catch(() => {}); await Bun.sleep(600); }
  }
  return failures;
}

/** Stops the scratch session and removes what the run made; once, however the run ends. */
let cleaned = false;
function cleanUp(): void {
  if (cleaned) return;
  cleaned = true;
  Bun.spawnSync(["herdr", "session", "stop", session], { env });
  server.kill();
  rmSync(root, { recursive: true, force: true });
  // Claude keeps a folder's transcripts under its path with every
  // non-alphanumeric character as "-", and its project memory under the
  // repository's; the run's folders and the repository's belong to these
  // journeys alone.
  const claudeProjects = join(homedir(), ".claude", "projects");
  const encoded = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, "-");
  let projects: string[] = [];
  try { projects = readdirSync(claudeProjects); } catch {}
  for (const name of projects) {
    if (name === encoded(realpathSync(repo)) || name.startsWith(encoded(runDir))) rmSync(join(claudeProjects, name), { recursive: true, force: true });
  }
  rmSync(runDir, { recursive: true, force: true });
}
// `timeout` and launchd end a run with a signal, which skips `finally`; a run
// killed that way once left its herdr session and agents behind.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { cleanUp(); process.exit(1); });

/** What an interactive shell, the kind herdr starts in a pane, prints for `script`. */
const inShell = (script: string) => Bun.spawnSync([process.env.SHELL || "/bin/bash", "-ic", script], { env, stdin: "ignore", stderr: "ignore", timeout: 20_000 }).stdout.toString().trim();

let failed = 0;
try {
  let pong!: { version: string; protocol: number };
  for (let tries = 0; ; tries++) {
    try { pong = await client.connect(); break; } catch (err) { if (tries > 40) throw err; await Bun.sleep(250); }
  }
  // The journeys call the routes' functions directly, past the service's own
  // gate, so they passed against herdr 0.9.5 on both computers while every
  // installed Shahi refused it (October 2026). Ask the gate as well.
  const gate = herdrCompatibility(pong.version, pong.protocol);
  const gateLabel = `herdr ${pong.version} (protocol ${pong.protocol}) admitted by the service`;
  if (gate.state !== "connected") failed++;
  console.log(`${gate.state === "connected" ? "ok  " : "FAIL"}    ${gateLabel}${gate.state === "connected" ? "" : `\n        ${gate.state}: ${gate.message}`}`);
  const { workspace } = await rpc("workspace.create", { cwd: runDir, label: "journeys", focus: false });
  for (const kind of kinds) {
    // Asked of the shell a pane runs, as discovery does: a profile that puts
    // ~/.local/bin first runs another copy than this process's PATH names,
    // and the label once said "agy 1.4.2" over journeys that ran 1.2.15.
    const command = agentCommand(kind);
    if (!inShell(`command -v ${command}`)) { console.log(`skip    ${kind}: not installed`); continue; }
    const version = inShell(`${command} --version 2>/dev/null`).split("\n")[0];
    for (const launch of launches) {
      const label = `${kind} (${version}) started ${launch === "shahi" ? "by Shahi" : "by hand"}`;
      const owner = kind === "codex" && launch === "hand" ? liveCodexDaemonOwner(join(xdg, "herdr", "sessions", session, "herdr.sock")) : null;
      if (owner) {
        console.log(`skip    ${label}\n        a shared Codex daemon belongs to herdr pane ${owner}, which would be told this journey's conversation is its own`);
        continue;
      }
      let failures: string[];
      try {
        failures = await Promise.race([
          journey(kind, launch, workspace.workspace_id),
          Bun.sleep(JOURNEY_MS).then(() => [`did not finish within ${JOURNEY_MS / 60_000} minutes`]),
        ]);
      }
      catch (err) {
        if (err instanceof Untestable) { console.log(`skip    ${label}\n        ${err.message}`); continue; }
        failures = [err instanceof Error ? err.message : String(err)];
      }
      if (failures.length) failed++;
      console.log(`${failures.length ? "FAIL" : "ok  "}    ${label}${failures.map((f) => `\n        ${f}`).join("")}`);
    }
  }
} finally {
  cleanUp();
}
console.log(failed ? `\n${failed} journey(s) failed.` : "\nEvery journey reached Reader and the agent list, and stayed there.");
process.exit(failed ? 1 : 0);
