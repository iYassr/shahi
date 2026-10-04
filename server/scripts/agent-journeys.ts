/**
 * Starts real agents the two ways people start them and checks the phone sees
 * each conversation, through the functions its routes call:
 *
 *   bun run server/scripts/agent-journeys.ts [claude] [codex] [shahi] [hand]
 *
 * For each installed agent: started by Shahi (`startAgentInTab`, as New agent
 * does) and started by hand (its plain command typed into a shell). A short
 * message goes in through `submitPrompt`, and once the reply is in the
 * transcript the run checks, every 5 s for a minute, that Reader finds the
 * conversation, that its page holds the reply, that the agent list's preview
 * does, and that Read agrees with Screen. Exits 1 if any journey fails.
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
 * transcripts for that folder are removed after the run; Codex's threads stay
 * in its history under that folder. Nothing prints conversation text: the
 * reply is a token, checked by comparison only.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startAgentInTab } from "../lib/agents";
import { answerPrompt } from "../lib/answer";
import { conversationSummary, transcriptPage, transcriptSourceFor } from "../lib/conversation-summary";
import { HerdrClient } from "../lib/herdr-client";
import { openReadOnly } from "../lib/foreign-sqlite";
import { submitPrompt, promptTarget } from "../lib/prompt";
import { parsePrompt } from "../lib/prompt-parser";
import { compare, disagreement } from "../lib/reader-parity";
import { SessionStore } from "../lib/state";

type Kind = "claude" | "codex";
type Launch = "shahi" | "hand";
const argv = new Set(process.argv.slice(2));
const kinds = (["claude", "codex"] as Kind[]).filter((kind) => (!argv.has("claude") && !argv.has("codex")) || argv.has(kind));
const launches = (["shahi", "hand"] as Launch[]).filter((launch) => (!argv.has("shahi") && !argv.has("hand")) || argv.has(launch));
const STEADY_MS = 60_000;

// herdr, and every shell it starts, without this process's own agent and herdr
// context: nested Claude Code refuses to start inside another.
const root = mkdtempSync("/tmp/shj."); // short: a macOS socket address holds 104 bytes
const xdg = join(root, "xdg");
const session = `shahi-journeys-${root.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
const env = Object.fromEntries(Object.entries({ ...process.env, XDG_CONFIG_HOME: xdg })
  .filter(([key]) => !/^(CLAUDE|HERDR|AI_AGENT|CODEX)/.test(key))) as Record<string, string>;

// One repository for every run, so its trust is asked once rather than written
// again for each run's folder; a folder per run inside it, so Codex never sees
// two threads of one name in one folder (its title lookup refuses those).
const repo = "/tmp/shahi-journeys";
mkdirSync(repo, { recursive: true });
if (!existsSync(join(repo, ".git"))) Bun.spawnSync(["git", "init", "--quiet", repo]);
const nonce = Math.random().toString(36).slice(2, 8);
const runDir = join(realpathSync(repo), `run-${nonce}`);
mkdirSync(runDir);

const server = Bun.spawn(["herdr", "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
const client = new HerdrClient({ socketPath: join(xdg, "herdr", "sessions", session, "herdr.sock"), timeoutMs: 10_000 });
const rpc = <T = any>(method: string, params: unknown, options?: { timeoutMs?: number }) =>
  client.rpc(method as never, params as never, options) as Promise<T>;
const store = new SessionStore(client);
const visible = async (paneId: string) => (await rpc("pane.read", { pane_id: paneId, source: "visible", format: "text", strip_ansi: true })).read.text as string;
const status = async (paneId: string) => (await rpc("pane.get", { pane_id: paneId })).pane?.agent_status as string | undefined;

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
    if (now === "idle" || now === "done") return;
  }
  throw new Error(`was not ready within 2 minutes (herdr says ${await status(paneId)})`);
}

async function start(kind: Kind, launch: Launch, workspaceId: string): Promise<string> {
  if (launch === "shahi") {
    const { paneId } = await startAgentInTab(rpc, { workspaceId, cwd: runDir, label: `${kind}-shahi`, kind, name: `${kind}-shahi-${nonce}` });
    return paneId;
  }
  const { root_pane: { pane_id: paneId } } = await rpc("tab.create", { workspace_id: workspaceId, label: `${kind}-hand`, cwd: runDir, focus: false });
  await Bun.sleep(2_000); // the shell's first prompt
  await rpc("pane.send_text", { pane_id: paneId, text: kind });
  await Bun.sleep(200);
  await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  return paneId;
}

interface Look { found: boolean; reply: boolean; preview: boolean; parity: string | null }
async function look(paneId: string, token: string): Promise<Look> {
  await store.resync();
  const pane = store.pane(paneId);
  if (!pane?.agent) return { found: false, reply: false, preview: false, parity: "herdr names no agent in the pane" };
  const source = await transcriptSourceFor(pane, client);
  const page = source ? await transcriptPage(paneId, source, pane.agent, { limit: 60 }) : null;
  const reply = !!page?.log.messages.some((message) => message.role !== "user" && JSON.stringify(message.blocks).includes(token));
  const preview = ((await conversationSummary(pane, client)).preview ?? "").includes(token);
  const parity = page ? disagreement(compare(await visible(paneId), pane.agent, page.log)) : "no transcript";
  return { found: !!source, reply, preview, parity };
}

/** What Reader had to go on, for a failure: herdr's view and the title, never conversation text. */
async function signals(paneId: string, token: string): Promise<string> {
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
        facts.push(`Codex threads with that name: ${rows.length}, in this folder: ${rows.filter((row) => row.cwd === runDir).length}`);
      } finally { db.close(); }
    } catch (err) { facts.push(`Codex index unreadable: ${(err as { code?: string }).code ?? err}`); }
  }
  return facts.join("; ");
}

async function journey(kind: Kind, launch: Launch, workspaceId: string): Promise<string[]> {
  const failures: string[] = [];
  const token = `shahi-${kind}-${launch}-${nonce}`;
  const paneId = await start(kind, launch, workspaceId);
  try {
    await ready(paneId);
    await store.resync();
    const target = await promptTarget(rpc as never, paneId, store.agent(paneId));
    await submitPrompt(rpc as never, target, `Reply with exactly the word ${token} and nothing else.`);
    // The reply, as Reader would show it, within three minutes.
    const deadline = Date.now() + 180_000;
    let seen = await look(paneId, token);
    while (!seen.reply && Date.now() < deadline) { await Bun.sleep(3_000); seen = await look(paneId, token); }
    if (!seen.reply) failures.push(`${seen.found ? "Reader found a conversation without the reply" : "Reader found no conversation"} (${await signals(paneId, token)})`);
    else {
      // Then a minute of looking again: the macOS index failure came and went.
      for (const end = Date.now() + STEADY_MS; Date.now() < end && failures.length === 0; await Bun.sleep(5_000)) {
        const again = await look(paneId, token);
        if (!again.found) failures.push(`Reader lost the conversation after ${Math.round((STEADY_MS - (end - Date.now())) / 1000)} s (${await signals(paneId, token)})`);
        else if (!again.reply) failures.push("Reader's page lost the reply");
        else if (!again.preview) failures.push(`the agent list showed no preview after ${Math.round((STEADY_MS - (end - Date.now())) / 1000)} s`);
        else if (again.parity) failures.push(`Read and Screen disagree: ${again.parity}`);
      }
    }
  } finally {
    // Two Ctrl-C leave either agent; the tab goes with whatever is left.
    for (let i = 0; i < 2; i++) { await rpc("pane.send_keys", { pane_id: paneId, keys: ["C-c"] }).catch(() => {}); await Bun.sleep(600); }
  }
  return failures;
}

let failed = 0;
try {
  for (let tries = 0; ; tries++) {
    try { await client.connect(); break; } catch (err) { if (tries > 40) throw err; await Bun.sleep(250); }
  }
  const { workspace } = await rpc("workspace.create", { cwd: runDir, label: "journeys", focus: false });
  for (const kind of kinds) {
    if (!Bun.which(kind, { PATH: env.PATH })) { console.log(`skip    ${kind}: not installed`); continue; }
    const version = Bun.spawnSync([kind, "--version"], { env }).stdout.toString().trim().split("\n")[0];
    for (const launch of launches) {
      const label = `${kind} (${version}) started ${launch === "shahi" ? "by Shahi" : "by hand"}`;
      let failures: string[];
      try { failures = await journey(kind, launch, workspace.workspace_id); }
      catch (err) { failures = [err instanceof Error ? err.message : String(err)]; }
      if (failures.length) failed++;
      console.log(`${failures.length ? "FAIL" : "ok  "}    ${label}${failures.map((f) => `\n        ${f}`).join("")}`);
    }
  }
} finally {
  Bun.spawnSync(["herdr", "session", "stop", session], { env });
  server.kill();
  rmSync(root, { recursive: true, force: true });
  // Claude keeps a folder's transcripts under its path with every
  // non-alphanumeric character as "-", and its project memory under the
  // repository's; both folders belong to these journeys alone.
  const claudeProjects = join(homedir(), ".claude", "projects");
  for (const folder of [runDir, realpathSync(repo)]) rmSync(join(claudeProjects, folder.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} journey(s) failed.` : "\nEvery journey reached Reader and the agent list, and stayed there.");
process.exit(failed ? 1 : 0);
