import { stat } from "node:fs/promises";
import type { HerdrClient } from "./herdr-client";
import type { PaneInfo } from "./herdr-schema";
import { findCodexRollout, readCodexWindow } from "./codex-log";
import { cursorTranscriptFor, readCursorLog } from "./cursor-log";
import { findTranscript, previewOf, readWindow, type SessionLog } from "./session-log";

type Summary = { preview: string | null; lastMessageAt: number | null };

/**
 * Each pane's last summary, and the state of the file it was read from.
 *
 * The dashboard summarises every pane every 3s while a client is connected,
 * and each summary used to read the transcript's tail through the readers'
 * index caches. Those hold 64 transcripts each, so a session with more agent
 * panes than that evicted, on every round, the indexes the same round needed
 * next, and each eviction cost a full parse of a transcript that can be tens
 * of megabytes (review finding, September 2026). An unchanged file now costs
 * one stat and never touches the readers' caches. The entries are a line of
 * text each, kept for exactly the panes that exist (`retainSummaries`), so
 * there is no count for a busy session to outgrow.
 */
const summaries = new Map<string, { path: string; version: string; summary: Summary }>();

/** Reuses indexed transcript tails, never terminal repaint times or another session. */
export async function conversationSummary(pane: PaneInfo, client?: HerdrClient): Promise<Summary> {
  try {
    const kind = pane.agent;
    const id = pane.agent_session?.value;
    const path = kind === "cursor" ? client ? await cursorTranscriptFor(client, pane.pane_id, id) : null
      : kind === "codex" ? client ? await findCodexRollout(client, pane.pane_id, pane.cwd ?? null, id) : null
      : id ? await findTranscript(id) : null;
    return path ? await transcriptSummary(pane.pane_id, path, kind) : summaryOf(null);
  } catch { return summaryOf(null); }
}

/** The summary of the transcript at `path`, read again only when the file has changed. */
export async function transcriptSummary(paneId: string, path: string, kind?: string | null): Promise<Summary> {
  // Stat before reading, so a write landing mid-read leaves an older version
  // on the entry and the next round reads again, rather than the reverse.
  const file = await stat(path);
  const version = `${file.ino}:${file.size}:${file.mtimeMs}`;
  const held = summaries.get(paneId);
  if (held && held.path === path && held.version === version) return held.summary;
  const log = kind === "cursor" ? await readCursorLog(path, { limit: 3 })
    : kind === "codex" ? await readCodexWindow(path, { limit: 3 })
    : await readWindow(path, { limit: 3 });
  // Cursor does not record timestamps. Its exact transcript's modification
  // time is the best available fallback, and survives a sidecar restart.
  const summary = summaryOf(log, kind === "cursor" ? file.mtimeMs : null);
  summaries.set(paneId, { path, version, summary });
  return summary;
}

/** Forgets the summaries of panes that no longer exist. */
export function retainSummaries(paneIds: Iterable<string>): void {
  const live = new Set(paneIds);
  for (const paneId of summaries.keys()) if (!live.has(paneId)) summaries.delete(paneId);
}

export function summaryOf(log: SessionLog | null, fallbackAt: number | null = null): Summary {
  const messages = log?.messages ?? [];
  const at = messages.at(-1)?.at || (messages.length ? fallbackAt : null);
  return { preview: previewOf(messages), lastMessageAt: at && Number.isFinite(at) && at > 0 ? at : null };
}
