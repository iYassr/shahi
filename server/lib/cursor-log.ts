/** Cursor CLI JSONL transcripts. Session ownership comes from herdr or the exact
 * pane process's open store.db; a shared working folder is never a match. */
import { readdir, readlink, realpath, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import type { HerdrClient } from "./herdr-client";
import { inTranscript, isRecord, normalise, readWindow, type LogMessage, type SessionLog } from "./session-log";
const ROOT = join(homedir(), ".cursor");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function cursorSessionFromStore(path: string, root = ROOT): string | null {
  const relative = resolve(path).slice(resolve(root).length + 1);
  if (!resolve(path).startsWith(resolve(root) + "/")) return null;
  const parts = relative.split("/");
  return parts.length === 4 && parts[0] === "chats" && parts[3] === "store.db" && UUID.test(parts[2]!) ? parts[2]! : null;
}
export async function findCursorTranscript(sessionId: string, root = ROOT): Promise<string | null> {
  if (!UUID.test(sessionId)) return null;
  const projects = join(root, "projects");
  try {
    const realRoot = await realpath(projects);
    const matches: string[] = [];
    for (const project of await readdir(projects)) {
      for (const tail of [join(sessionId, `${sessionId}.jsonl`), `${sessionId}.jsonl`]) {
        try {
          const path = await realpath(join(projects, project, "agent-transcripts", tail));
          if (path.startsWith(realRoot + "/")) matches.push(path);
        } catch { /* This project does not own that session. */ }
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}
async function openFiles(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  if (process.platform !== "darwin") {
    try { return (await Promise.all((await readdir(`/proc/${pid}/fd`)).map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")))); }
    catch { return []; }
  }
  const scratch = await mkdtemp(join(tmpdir(), "shahi-cursor-"));
  try {
    const output = join(scratch, "files");
    const proc = Bun.spawn(["/bin/sh", "-c", 'exec /usr/sbin/lsof -a -p "$1" -Fn > "$2"', "shahi-cursor", String(pid), output], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 2000);
    try { await proc.exited; } finally { clearTimeout(timer); }
    return (await readFile(output, "utf8")).split("\n").filter(x => x.startsWith("n")).map(x => x.slice(1));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function cursorTranscriptFor(client: HerdrClient, paneId: string, sessionId?: string | null): Promise<string | null> {
  if (sessionId) { const found = await findCursorTranscript(sessionId); if (found) return found; }
  try {
    const info = await client.rpc("pane.process_info", { pane_id: paneId }) as { process_info?: { foreground_processes?: { pid: number }[] } };
    const ids = new Set<string>();
    for (const process of info.process_info?.foreground_processes ?? []) {
      for (const path of await openFiles(process.pid)) { const id = cursorSessionFromStore(path); if (id) ids.add(id); }
    }
    return ids.size === 1 ? findCursorTranscript([...ids][0]!) : null;
  } catch { return null; }
}
/**
 * What the person typed, out of the wrappers Cursor puts around a user turn.
 *
 * Cursor sends the model its context in tags and records that verbatim, so
 * every user bubble showed `<timestamp>…</timestamp><user_query>…` and one
 * showed a 2,901-character `<dynamic_tools>` catalogue as something the person
 * sent (review finding, September 2026). A census of the local transcripts
 * (tag names only): 21 of 22 user blocks open with `<timestamp>`, 14 carry the
 * typed text in `<user_query>`, and none has text outside a tag. So the query
 * is the message, and any other wrapped element is context for the model:
 * dropped, never guessed at. Plain text, the shape older transcripts and the
 * tests use, still comes through once leading wrappers are removed.
 */
export function cursorUserText(text: string): string {
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  if (queries.length > 0) return queries.join("\n\n");
  let rest = text;
  for (let wrapped; (wrapped = /^\s*<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/.exec(rest)); ) {
    rest = rest.slice(wrapped[0].length);
  }
  return rest.trim();
}

/** Cursor currently records calls without results or timestamps. Don't invent
 * either, and don't describe a historical call as still running forever. */
export function normaliseCursor(rows: Record<string, unknown>[], start = 0): LogMessage[] {
  let position = start;
  return rows.flatMap((row) => {
    // A bare `null` line, or a field of a type Cursor never wrote, is dropped
    // like any unknown shape; it used to throw and fail the page (pre-release
    // bug hunt, September 2026). `normalise` checks the blocks' own fields.
    if (!isRecord(row) || (row.role !== "user" && row.role !== "assistant")) return [];
    const content = isRecord(row.message) ? row.message.content : undefined;
    if (!Array.isArray(content)) return [];
    const safe = content
      .filter((b): b is Record<string, unknown> => isRecord(b) && ["text", "thinking", "tool_use"].includes(b.type as string))
      .map(b => row.role === "user" && b.type === "text" ? { ...b, text: typeof b.text === "string" ? cursorUserText(b.text) : "" } : b);
    const messages = normalise([{ type: row.role, uuid: `cursor-${position}`, message: { content: safe } }]);
    position += messages.length;
    return messages.map(m => ({ ...m, blocks: m.blocks.map(b => b.kind === "tool" ? { ...b, outputUnavailable: true } : b) }));
  });
}
export async function readCursorLog(path: string, options: { limit?: number; before?: number } = {}): Promise<SessionLog | null> {
  const log = await readWindow(path, options, normaliseCursor);
  return log && inTranscript(log, basename(path, ".jsonl"));
}
