/**
 * Reads codex's session transcripts, for the same reader view Claude Code gets.
 *
 * codex stores things quite differently, and two of the differences matter:
 *
 * **There is no session id to join on.** herdr populates `agent_session` for
 * Claude panes and leaves it `null` for codex, so the trick that works there —
 * session id is the transcript's filename — has nothing to stand on. Instead
 * the pane's foreground process is asked what file it has open: herdr's
 * `pane.process_info` gives the codex pid, and `/proc/<pid>/fd` holds a symlink
 * to the rollout it is writing. That is exact rather than a guess. Matching on
 * working directory is the fallback, and only a fallback, because two codex
 * sessions in one directory would be indistinguishable.
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
 * Exact when the process is inspectable; falls back to the most recently
 * updated thread for the pane's directory otherwise.
 */
export async function findCodexRollout(
  client: HerdrClient,
  paneId: string,
  cwd: string | null,
): Promise<string | null> {
  const viaProcess = await rolloutFromProcess(client, paneId);
  if (viaProcess) return viaProcess;
  return cwd ? rolloutFromIndex(cwd) : null;
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
  options: { limit?: number; before?: number } = {},
): Promise<SessionLog | null> {
  const path = await findCodexRollout(client, paneId, cwd);
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
