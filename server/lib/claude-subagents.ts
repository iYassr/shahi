/**
 * Which call started a Claude subagent, for the reports that name only the
 * subagent's task id.
 *
 * Claude Code 2.1.311 ends a background subagent with a hand-back message and
 * a notice that carry its task id and not the `Agent` call's id, so Reader
 * could not fold either into the subagent's row, which then said "running"
 * for good (measured 27 October 2026). Claude Code keeps the pair beside the
 * transcript, `<session>/subagents/agent-<task id>.meta.json` (`toolUseId`,
 * `description`, `finished`), written when the agent starts and so before any
 * report of it. Reading it keeps a report's message independent of which page
 * of the transcript is loaded, which joining it to the launch receipt would not.
 */
import type { LogBlock, LogMessage, SessionLog } from "@shahi/shared";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MAX_META_BYTES = 16 * 1024;
const MAX_LOOKUPS = 64;
const ID = /^[\w-]{1,200}$/;

/** The page with each task id resolved to its call where Claude Code recorded one, and dropped either way. */
export async function withSubagentCalls(log: SessionLog, transcript: string): Promise<SessionLog> {
  const ids = new Set<string>();
  for (const message of log.messages) for (const block of message.blocks) {
    if (block.kind === "text" && block.notice?.taskId) ids.add(block.notice.taskId);
  }
  if (ids.size === 0) return log;
  const folder = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  const calls = new Map<string, string>();
  await Promise.all([...ids].slice(0, MAX_LOOKUPS).map(async (taskId) => {
    const call = await callOf(folder, taskId);
    if (call) calls.set(taskId, call);
  }));
  const resolve = (block: LogBlock): LogBlock => {
    if (block.kind !== "text" || !block.notice?.taskId) return block;
    const { taskId, ...notice } = block.notice;
    const toolUseId = calls.get(taskId);
    return { ...block, notice: toolUseId ? { ...notice, toolUseId } : notice };
  };
  const messages = log.messages.map((message): LogMessage =>
    message.blocks.some(block => block.kind === "text" && block.notice?.taskId) ? { ...message, blocks: message.blocks.map(resolve) } : message);
  return { ...log, messages };
}

/** The `Agent` call's id from one subagent's metadata, or null for anything missing, oversized or unrecognised. */
async function callOf(folder: string, taskId: string): Promise<string | null> {
  if (!ID.test(taskId)) return null;
  let raw: string;
  try {
    // Opened without blocking and checked on that handle, as the task list's
    // files are (claude-tasks.ts): a FIFO under the name would hold the read.
    const handle = await open(join(folder, `agent-${taskId}.meta.json`), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > MAX_META_BYTES) return null;
      raw = await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
  try {
    const meta = JSON.parse(raw) as unknown;
    const toolUseId = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>).toolUseId : undefined;
    return typeof toolUseId === "string" && ID.test(toolUseId) ? toolUseId : null;
  } catch { return null; }
}
