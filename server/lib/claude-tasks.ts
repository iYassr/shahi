/**
 * Claude Code's task list for a session, as its own terminal shows it.
 *
 * TaskCreate and TaskUpdate write one JSON file per task under
 * `<config>/tasks/<sessionId>/` (`{id, subject, description, activeForm,
 * status, blocks, blockedBy}`, measured on Claude Code 2.1 in October 2026),
 * and a deleted task's file is removed. Reading that store is exact and does
 * not depend on how much of the transcript a phone has loaded; rebuilding the
 * list from TaskCreate/TaskUpdate calls would be wrong whenever a task was
 * created before the loaded page began, which in a long session is most of
 * them.
 *
 * The page cache is keyed on the transcript's stat, and that is enough here:
 * every change to the store is a tool call whose result is appended to the
 * transcript after the store is written.
 */
import type { ReaderTask } from "@shahi/shared";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./session-log";

const MAX_TASKS = 200;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT = 300;
const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** The session's tasks in order, or undefined when it has never had any. */
export async function claudeTasks(sessionId: string): Promise<ReaderTask[] | undefined> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return undefined;
  const dir = join(claudeConfigDir(), "tasks", sessionId);
  let names: string[];
  try { names = await readdir(dir); } catch { return undefined; }
  const files = names.filter(name => /^\d{1,9}\.json$/.test(name))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .slice(-MAX_TASKS);
  const tasks = await Promise.all(files.map(name => readTask(join(dir, name))));
  return tasks.filter((task): task is ReaderTask => task !== null);
}

/** One task file, or null for anything unreadable, oversized or unrecognised. */
async function readTask(path: string): Promise<ReaderTask | null> {
  let raw: string;
  try {
    // Opened without blocking and checked on that handle, as `/api/file`
    // does: a FIFO under the name would otherwise hold the read forever.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > MAX_FILE_BYTES) return null;
      raw = await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
  let task: unknown;
  try { task = JSON.parse(raw); } catch { return null; }
  if (typeof task !== "object" || task === null) return null;
  const { id, subject, status, activeForm } = task as Record<string, unknown>;
  if (typeof id !== "string" || typeof subject !== "string" || !subject.trim() || !STATUSES.has(status as string)) return null;
  const active = typeof activeForm === "string" && activeForm.trim() ? clip(activeForm.trim()) : undefined;
  return { id, subject: clip(subject.trim()), status: status as ReaderTask["status"], ...(active ? { activeForm: active } : {}) };
}

/** At most MAX_TEXT characters, cut between graphemes so an emoji is never halved. */
function clip(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (out.length + segment.length > MAX_TEXT - 1) break;
    out += segment;
  }
  return `${out}…`;
}
