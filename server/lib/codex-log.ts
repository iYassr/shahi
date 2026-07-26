/**
 * Reads codex's session transcripts, for the same reader view Claude Code gets.
 *
 * codex stores things quite differently, and two of the differences matter:
 *
 * **The session id has to be earned.** herdr populates `agent_session` for
 * Claude panes out of the box; for codex it only does so once its codex
 * integration is installed, because that is what puts a SessionStart hook in
 * `~/.codex/hooks.json` to report the id. Where the id is there, it is the best
 * answer available and it outlives the process. Where it is not, the pane's
 * foreground process is asked what file it has open: herdr's
 * `pane.process_info` gives the codex pid, and `/proc/<pid>/fd` holds a symlink
 * to the rollout it is writing. Matching on working directory is the last
 * fallback, because two codex sessions in one directory are indistinguishable
 * there and the newer one would win whichever pane asked.
 *
 * **The transcript has two views of the same conversation, and one is a trap.**
 * `response_item` records are the raw API turns, which include `developer`-role
 * system prompts and a `<environment_context>` block sent as a user turn.
 * Rendering those would put codex's own instructions in your mouth — the same
 * mistake as attributing Claude's `tool_result` records to the user. The
 * `event_msg` records are the UI-level view, already stripped to what a person
 * actually said and what the agent actually replied, so those are what the
 * reader uses.
 */
import { Database } from "bun:sqlite";
import { readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrClient } from "./herdr-client";
import { parseLines, type LogMessage, type SessionLog } from "./session-log";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");

/**
 * The thread index.
 *
 * Versioned in the filename — `state_5` today — because codex migrates it. A
 * bump means this lookup silently finds nothing, which degrades to "no
 * transcript" rather than to wrong data.
 */
const STATE_DB = join(CODEX_HOME, "state_5.sqlite");

/**
 * Finds the rollout file a pane's codex process is writing.
 *
 * Three routes, best first. The session id is exact and survives the process
 * exiting; `/proc` is exact while it is alive; the working directory is a guess
 * and only ever a fallback.
 */
export async function findCodexRollout(
  client: HerdrClient,
  paneId: string,
  cwd: string | null,
  sessionId?: string | null,
): Promise<string | null> {
  const viaSession = sessionId ? rolloutFromSessionId(sessionId) : null;
  if (viaSession) return viaSession;
  const viaProcess = await rolloutFromProcess(client, paneId);
  if (viaProcess) return viaProcess;
  return cwd ? rolloutFromIndex(cwd) : null;
}

/**
 * Resolves a codex session id to its rollout.
 *
 * The id only exists once herdr's codex integration is installed: its
 * SessionStart hook reports it through `pane.report_agent_session`, and herdr
 * then carries it on the pane as `agent_session.value` — the same field the
 * Claude reader has always joined on. Without the integration this returns
 * nothing and the older routes below still work, which is why this is an
 * addition rather than a replacement.
 *
 * The index is asked first and the filename glob is the backstop: codex writes
 * the id into the rollout's name (`rollout-<when>-<id>.jsonl`), so a thread the
 * index has not caught up with is still findable.
 */
function rolloutFromSessionId(sessionId: string): string | null {
  // Ids come from another process; only ever let a real one near a path.
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

  try {
    const db = new Database(STATE_DB, { readonly: true });
    const row = db
      .query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?")
      .get(sessionId);
    db.close();
    if (row?.rollout_path) return row.rollout_path;
  } catch {
    // A migrated or missing index is not fatal — fall through to the glob.
  }

  try {
    const matches = [...new Bun.Glob(`**/rollout-*-${sessionId}.jsonl`).scanSync(SESSIONS_DIR)];
    if (matches.length > 0) return join(SESSIONS_DIR, matches.sort().at(-1)!);
  } catch {
    // No sessions directory yet.
  }
  return null;
}

/** Asks the pane's foreground process which rollout it has open. */
async function rolloutFromProcess(client: HerdrClient, paneId: string): Promise<string | null> {
  let pids: number[];
  try {
    const info = (await client.rpc("pane.process_info" as never, { pane_id: paneId } as never)) as {
      process_info?: { foreground_processes?: { pid: number; name: string }[] };
    };
    pids = (info.process_info?.foreground_processes ?? [])
      .filter((p) => p.name === "codex")
      .map((p) => p.pid);
  } catch {
    return null;
  }

  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        if (target.startsWith(SESSIONS_DIR) && target.endsWith(".jsonl")) return target;
      } catch {
        // Descriptor closed between listing and reading; normal on a live process.
      }
    }
  }
  return null;
}

/**
 * Falls back to the thread index.
 *
 * Deliberately last: two codex sessions in the same directory are
 * indistinguishable here, and the newer one would win regardless of which pane
 * asked.
 */
function rolloutFromIndex(cwd: string): string | null {
  try {
    const db = new Database(STATE_DB, { readonly: true });
    const row = db
      .query<{ rollout_path: string }, [string]>(
        "SELECT rollout_path FROM threads WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(cwd);
    db.close();
    return row?.rollout_path ?? null;
  } catch {
    return null;
  }
}

/**
 * Turns rollout records into the same shape the Claude reader produces.
 *
 * Only `event_msg` is read. `response_item` carries the raw API conversation
 * including developer-role system prompts and an `<environment_context>` block
 * delivered as a user turn — see the module note.
 */
export function normaliseCodex(rows: Record<string, unknown>[]): LogMessage[] {
  const messages: LogMessage[] = [];

  for (const [index, row] of rows.entries()) {
    if (row.type !== "event_msg") continue;

    const payload = row.payload as { type?: string; message?: string } | undefined;
    const text = payload?.message?.trim();
    if (!text) continue;

    const role =
      payload?.type === "user_message" ? "you" : payload?.type === "agent_message" ? "agent" : null;
    // task_started, task_complete, token_count and anything codex adds later
    // are lifecycle, not conversation.
    if (!role) continue;

    messages.push({
      id: `codex-${index}`,
      role,
      at: Date.parse((row.timestamp as string) ?? "") || 0,
      blocks: [{ kind: "text", text }],
    });
  }

  return messages;
}

/** Reads and normalises a codex rollout into the reader's shape. */
export async function readCodexLog(
  client: HerdrClient,
  paneId: string,
  cwd: string | null,
  options: { limit?: number; before?: number; sessionId?: string | null } = {},
): Promise<SessionLog | null> {
  const path = await findCodexRollout(client, paneId, cwd, options.sessionId);
  if (!path) return null;

  const file = Bun.file(path);
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }

  const all = normaliseCodex(parseLines(text));
  const limit = options.limit ?? 200;
  const end = options.before ?? all.length;
  const start = Math.max(0, end - limit);

  return {
    sessionId: path.split("/").pop()?.replace(/\.jsonl$/, "") ?? paneId,
    path,
    messages: all.slice(start, end),
    total: all.length,
    offset: file.size,
  };
}
