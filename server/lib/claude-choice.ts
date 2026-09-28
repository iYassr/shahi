/**
 * A Claude conversation a person named for a pane herdr cannot identify.
 *
 * Reader follows the session id Claude reports through herdr's integration
 * hook, and a Claude started before that hook was installed never reports one
 * (herdr-integrations.ts). Its conversation is on disk, and nothing on the
 * computer says which file it is: Claude does not keep its transcript open, so
 * the process-file lookup that works for Codex has nothing to find, and
 * Claude's own `sessions/<pid>.json` is undocumented, disagreed with the hook
 * for one of six live panes (2026-09-28), and is not written by every process.
 * A TestFlight tester's existing conversation stayed empty in Reader this way.
 *
 * So the person says which it is. The phone lists the conversations Claude
 * saved for the folder that Claude runs in, newest first, with the one
 * Claude's process record names marked likely, and the choice holds for that
 * Claude process only: its pid, in that terminal. A new process, a new
 * terminal or a session id from the hook ends it, and the hook always wins.
 * The folder only lists candidates; nothing is chosen without the person.
 */
import type { ConversationChoice } from "@shahi/shared";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HerdrClient } from "./herdr-client";
import { agentSessionOf } from "./herdr-pane";
import type { PaneInfo } from "./herdr-schema";
import { claudeConfigDir, findTranscript, normalise, parseLines, previewOf } from "./session-log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CHOICES = 20;
/** Enough of each end of a transcript for its first prompt and last message. */
const EDGE_BYTES = 64 * 1024;

type Rpc = Pick<HerdrClient, "rpc">;
type Pane = Pick<PaneInfo, "pane_id" | "terminal_id" | "agent" | "agent_session" | "cwd">;
interface Foreground { pid: number; name?: string; argv0?: string | null; argv?: string[] | null; cwd?: string | null }

const chosen = new Map<string, { terminal: string; pid: number; sessionId: string }>();

/**
 * Claude's folder for a working directory: every character but a letter or
 * digit becomes `-` (`/Users/me/.herdr/x` is `-Users-me--herdr-x`), as the
 * folders under `~/.claude/projects` show.
 */
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The pane's foreground processes. Throws when herdr does not answer. */
async function foreground(client: Rpc, paneId: string): Promise<Foreground[]> {
  const reply = await client.rpc("pane.process_info", { pane_id: paneId }) as { process_info?: { foreground_processes?: Foreground[] } };
  return reply.process_info?.foreground_processes ?? [];
}

/**
 * Native installs name the process after its version (`2.1.283`) and keep
 * argv0 `claude`, measured on herdr 0.9.1; an npm install runs `node …/claude`.
 */
const isClaude = (p: Foreground) =>
  p.name === "claude" || basename(p.argv0 ?? "") === "claude" || (p.argv ?? []).slice(0, 2).some((arg) => basename(arg) === "claude");

const readRecord = async (...path: string[]) => JSON.parse(await readFile(join(claudeConfigDir(), ...path), "utf8")) as Record<string, unknown>;

/**
 * The session Claude's own record names for a process: a hint, never a choice.
 * A process that parked its conversation as a background job keeps its old
 * `sessionId` and names the job in `parkedJobId` (`9ec2cbc1`), whose
 * `jobs/<id>/state.json` holds the conversation's session: measured on
 * 2.1.283, where the foreground record's own session disagreed with herdr's
 * hook and the job's agreed. That was the one mismatch in six live panes.
 */
async function recordedSession(pid: number): Promise<string | null> {
  try {
    const row = await readRecord("sessions", `${pid}.json`);
    if (row.pid !== pid) return null;
    if (row.parkedJobId !== undefined && row.parkedJobId !== null) {
      if (typeof row.parkedJobId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(row.parkedJobId)) return null;
      const job = await readRecord("jobs", row.parkedJobId, "state.json");
      return typeof job.sessionId === "string" ? job.sessionId : null;
    }
    return typeof row.sessionId === "string" ? row.sessionId : null;
  } catch {
    return null;
  }
}

async function edges(path: string, size: number): Promise<{ head: string; tail: string }> {
  const file = await open(path, "r");
  try {
    const read = async (position: number, length: number) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, position);
      return bytes.subarray(0, bytesRead).toString("utf8");
    };
    const head = await read(0, Math.min(size, EDGE_BYTES));
    return { head, tail: size > EDGE_BYTES ? await read(size - EDGE_BYTES, EDGE_BYTES) : head };
  } finally {
    await file.close();
  }
}

const flat = (text: string) => text.replace(/[#*`_>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160) || null;

/**
 * What a person recognises a conversation by: what they first asked and what
 * was said last. Read from the two ends only, because a transcript can be tens
 * of megabytes and whether a row makes a message depends on that row alone
 * (session-log.ts); a line cut at either edge fails to parse and is skipped.
 */
async function describe(path: string, size: number): Promise<{ firstPrompt: string | null; lastMessage: string | null }> {
  const { head, tail } = await edges(path, size);
  const first = normalise(parseLines(head)).find((message) => message.role === "you");
  const text = first?.blocks.find((block) => block.kind === "text");
  return { firstPrompt: text?.kind === "text" ? flat(text.text) : null, lastMessage: previewOf(normalise(parseLines(tail))) };
}

async function listFor(pid: number, cwd: string, claimed: ReadonlySet<string>): Promise<ConversationChoice[]> {
  const dir = join(claudeConfigDir(), "projects", projectFolder(cwd));
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const files = (await Promise.all(names.map(async (name) => {
    const sessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!UUID.test(sessionId) || claimed.has(sessionId)) return null;
    try {
      const file = await stat(join(dir, name));
      return file.isFile() && file.size > 0 ? { sessionId, path: join(dir, name), size: file.size, updatedAt: Math.round(file.mtimeMs) } : null;
    } catch {
      return null;
    }
  }))).filter((file) => file !== null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHOICES);
  const likely = await recordedSession(pid);
  const choices = (await Promise.all(files.map(async (file) => {
    try {
      const said = await describe(file.path, file.size);
      if (!said.firstPrompt && !said.lastMessage) return null;
      return { sessionId: file.sessionId, ...said, updatedAt: file.updatedAt, likely: file.sessionId === likely };
    } catch {
      return null;
    }
  }))).filter((choice) => choice !== null);
  // Stable, so the rest stay newest first.
  return choices.sort((a, b) => Number(b.likely) - Number(a.likely));
}

/**
 * The conversations a person may name for a Claude pane herdr cannot
 * identify, excluding those `claimed` by other panes. Empty when herdr
 * identifies it already, or when one Claude process is not the pane's.
 */
export async function conversationChoices(client: Rpc, pane: Pane, claimed: ReadonlySet<string>): Promise<ConversationChoice[]> {
  if (pane.agent !== "claude" || agentSessionOf(pane)) return [];
  let claude: Foreground[];
  try { claude = (await foreground(client, pane.pane_id)).filter(isClaude); } catch { return []; }
  const cwd = claude[0]?.cwd ?? pane.cwd;
  return claude.length === 1 && cwd ? listFor(claude[0]!.pid, cwd, claimed) : [];
}

/** Records a person's choice, if it is one of the pane's choices now. */
export async function chooseConversation(client: Rpc, pane: Pane, sessionId: string, claimed: ReadonlySet<string>): Promise<boolean> {
  if (!UUID.test(sessionId) || pane.agent !== "claude" || agentSessionOf(pane)) return false;
  let claude: Foreground[];
  try { claude = (await foreground(client, pane.pane_id)).filter(isClaude); } catch { return false; }
  const cwd = claude[0]?.cwd ?? pane.cwd;
  if (claude.length !== 1 || !cwd) return false;
  if (!(await listFor(claude[0]!.pid, cwd, claimed)).some((choice) => choice.sessionId === sessionId)) return false;
  // One canonical file under the projects root; a copy elsewhere is refused.
  if (!(await findTranscript(sessionId))) return false;
  chosen.set(pane.pane_id, { terminal: pane.terminal_id, pid: claude[0]!.pid, sessionId });
  return true;
}

/** The session chosen for a pane, unchecked: for telling other panes it is taken. */
export const choiceHeld = (paneId: string): string | null => chosen.get(paneId)?.sessionId ?? null;

/**
 * The session a person chose for this pane, while the process they chose it
 * for still runs there. A pid alone could outlive the choice in another
 * terminal, and a terminal outlives the Claude that ran in it.
 */
export async function chosenSession(client: Rpc | undefined, pane: Pane): Promise<string | null> {
  const held = chosen.get(pane.pane_id);
  if (!held) return null;
  if (pane.agent !== "claude" || agentSessionOf(pane) || held.terminal !== pane.terminal_id) {
    chosen.delete(pane.pane_id);
    return null;
  }
  if (!client) return null;
  let running: Foreground[];
  // herdr not answering is not evidence the process ended.
  try { running = await foreground(client, pane.pane_id); } catch { return null; }
  // Any foreground process, not only one named claude: a tool it runs can
  // share its process group.
  if (running.some((process) => process.pid === held.pid)) return held.sessionId;
  chosen.delete(pane.pane_id);
  return null;
}

/** Called when herdr reports the pane closed. */
export function forgetChoice(paneId: string): void {
  chosen.delete(paneId);
}
