/** Cursor CLI JSONL transcripts. Session ownership comes from herdr or the exact
 * pane process's open store.db; a shared working folder is never a match. */
import { readdir, readlink, realpath, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import type { HerdrClient } from "./herdr-client";
import { normalise, readWindow, type LogMessage, type SessionLog } from "./session-log";
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
/** Cursor currently records calls without results or timestamps. Don't invent
 * either, and don't describe a historical call as still running forever. */
export function normaliseCursor(rows: Record<string, unknown>[], start = 0): LogMessage[] {
  let position = start;
  return rows.flatMap((row) => {
    if (row.role !== "user" && row.role !== "assistant") return [];
    const content = (row.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const safe = content.filter(b => b && ["text", "thinking", "tool_use"].includes(b.type));
    const messages = normalise([{ type: row.role, uuid: `cursor-${position}`, message: { content: safe } }]);
    position += messages.length;
    return messages.map(m => ({ ...m, blocks: m.blocks.map(b => b.kind === "tool" ? { ...b, outputUnavailable: true } : b) }));
  });
}
export async function readCursorLog(path: string, options: { limit?: number; before?: number } = {}): Promise<SessionLog | null> {
  const log = await readWindow(path, options, normaliseCursor);
  return log && { ...log, sessionId: basename(path, ".jsonl") };
}
