/**
 * A pane's conversation, as its agent's transcript records it: where that
 * transcript is, the dashboard's one-line summary of it, and the reader's page.
 *
 * Both the summary and the page are kept with the state of the file they were
 * read from, so polling a quiet conversation costs a stat rather than a read,
 * and both are kept for exactly the panes that exist (`retainSummaries`).
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { HerdrClient } from "./herdr-client";
import type { PaneInfo } from "./herdr-schema";
import { findCodexRollout, readCodexLog } from "./codex-log";
import { cursorTranscriptFor, readCursorLog } from "./cursor-log";
import { findTranscript, previewOf, readWindow, type SessionLog } from "./session-log";
import { agentSessionOf } from "./herdr-pane";

type Summary = { preview: string | null; lastMessageAt: number | null };
type Window = { limit?: number; before?: number };

/** Where a pane's transcript is, looked up afresh: the reported session first, then the pane's process. */
export function transcriptPathFor(pane: PaneInfo, client?: HerdrClient): Promise<string | null> {
  // Never a session herdr kept after its agent left the pane (see herdr-pane.ts).
  const id = agentSessionOf(pane);
  return pane.agent === "cursor" ? (client ? cursorTranscriptFor(client, pane.pane_id, id) : Promise.resolve(null))
    : pane.agent === "codex" ? (client ? findCodexRollout(client, pane.pane_id, pane.cwd ?? null, id) : Promise.resolve(null))
    : id ? findTranscript(id) : Promise.resolve(null);
}

/** Reads a window of the transcript at `path` the way its agent writes it. */
async function readTranscript(path: string, kind: string | null | undefined, window: Window): Promise<SessionLog | null> {
  if (kind === "cursor") return readCursorLog(path, window);
  if (kind === "codex") return readCodexLog(path, window);
  // A Claude transcript is named after its session.
  const log = await readWindow(path, window);
  return log && { ...log, sessionId: basename(path, ".jsonl") };
}

/**
 * What a transcript's cached reads are checked against. Stat before reading,
 * so a write landing mid-read leaves an older version on the entry and the
 * next poll reads again, rather than the reverse.
 */
async function versionOf(path: string): Promise<{ version: string; mtimeMs: number }> {
  const file = await stat(path);
  return { version: `${file.ino}:${file.size}:${file.mtimeMs}`, mtimeMs: file.mtimeMs };
}

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
    const path = await transcriptPathFor(pane, client);
    return path ? await transcriptSummary(pane.pane_id, path, pane.agent) : summaryOf(null);
  } catch { return summaryOf(null); }
}

/** The summary of the transcript at `path`, read again only when the file has changed. */
export async function transcriptSummary(paneId: string, path: string, kind?: string | null): Promise<Summary> {
  const { version, mtimeMs } = await versionOf(path);
  const held = summaries.get(paneId);
  if (held && held.path === path && held.version === version) return held.summary;
  const log = await readTranscript(path, kind, { limit: 3 });
  // Cursor does not record timestamps. Its exact transcript's modification
  // time is the best available fallback, and survives a sidecar restart.
  const summary = summaryOf(log, kind === "cursor" ? mtimeMs : null);
  summaries.set(paneId, { path, version, summary });
  return summary;
}

/** A reader's page and its ETag, which the route answers `If-None-Match` with. */
export interface Page { log: SessionLog; etag: string }

/**
 * Each pane's recent reader pages, while the file they were read from is
 * unchanged.
 *
 * The reader polls every 2.5s, and each poll read its page's byte range and
 * parsed it again before the ETag could say nothing had changed. A page whose
 * last 60 messages held screenshots or a long tool result was megabytes of
 * JSON per poll: the pre-release bug hunt watched memory climb from 38 to
 * 138MB over 12 polls with 20 screenshots, and to ~415MB with one 30MB row.
 * Now an unchanged transcript costs a stat, and the ETag was computed when the
 * page was read. A few windows are kept per pane, because a phone and a laptop
 * reading the same pane ask for different ones, and "Load earlier" asks for
 * more.
 */
const pages = new Map<string, { path: string; version: string; windows: Map<string, Page> }>();
const MAX_WINDOWS_PER_PANE = 4;

/** The reader's page of the transcript at `path`, or null when there is no such transcript. */
export async function transcriptPage(paneId: string, path: string, kind: string | null | undefined, window: Window): Promise<Page | null> {
  let version: string;
  try { ({ version } = await versionOf(path)); } catch { return null; }
  let held = pages.get(paneId);
  if (!held || held.path !== path || held.version !== version) {
    held = { path, version, windows: new Map() };
    pages.set(paneId, held);
  }
  const key = `${window.limit ?? ""}:${window.before ?? ""}`;
  const cached = held.windows.get(key);
  if (cached) {
    held.windows.delete(key);
    held.windows.set(key, cached);
    return cached;
  }
  const log = await readTranscript(path, kind, window);
  if (!log) return null;
  const page = { log, etag: `W/"${Bun.hash(JSON.stringify(log)).toString(36)}"` };
  // Kept only if no newer version of the file replaced the entry meanwhile.
  if (pages.get(paneId) === held) {
    held.windows.set(key, page);
    for (const old of [...held.windows.keys()].slice(0, Math.max(0, held.windows.size - MAX_WINDOWS_PER_PANE))) held.windows.delete(old);
  }
  return page;
}

/** Forgets the summaries and pages of panes that no longer exist. */
export function retainSummaries(paneIds: Iterable<string>): void {
  const live = new Set(paneIds);
  for (const cache of [summaries, pages]) {
    for (const paneId of cache.keys()) if (!live.has(paneId)) cache.delete(paneId);
  }
}

export function summaryOf(log: SessionLog | null, fallbackAt: number | null = null): Summary {
  const messages = log?.messages ?? [];
  const at = messages.at(-1)?.at || (messages.length ? fallbackAt : null);
  return { preview: previewOf(messages), lastMessageAt: at && Number.isFinite(at) && at > 0 ? at : null };
}
