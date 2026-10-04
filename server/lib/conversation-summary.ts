/**
 * A pane's conversation, as its agent's transcript records it: where that
 * transcript is, the dashboard's one-line summary of it, and the reader's page.
 *
 * Both the summary and the page are kept with the state of their source, so
 * polling a quiet conversation costs file stats rather than another parse,
 * and both are kept for exactly the panes that exist (`retainSummaries`).
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { HerdrClient } from "./herdr-client";
import type { PaneInfo } from "./herdr-schema";
import { findCodexRollout, readCodexLog } from "./codex-log";
import { cursorTranscriptFor, readCursorLog } from "./cursor-log";
import { antigravityTranscriptFor, readAntigravityLog } from "./antigravity-log";
import { findOpenCodeTranscript, openCodeStamp, readOpenCodeLog, type OpenCodeTranscript } from "./opencode-log";
import { continuedTranscript, findTranscript, previewOf, readWindow, type SessionLog } from "./session-log";
import { agentSessionOf } from "./herdr-pane";
import { choiceHeld, chosenSession, parkedSession } from "./claude-choice";
import { fitPage } from "./session-window";
import { claudeTasks } from "./claude-tasks";
import type { TranscriptWatchSource } from "./transcript-watch";

type Summary = { preview: string | null; lastMessageAt: number | null };
type Window = { limit?: number; before?: number };
export type TranscriptSource = string | OpenCodeTranscript;

const sourceKey = (source: TranscriptSource): string => typeof source === "string"
  ? source : JSON.stringify([source.kind, source.databasePath, source.sessionId]);

/**
 * Where the dashboard last found each pane's transcript, and what that
 * answer depends on.
 *
 * Finding a Codex or Cursor transcript without a reported session asks the
 * pane's process which file it has open: a herdr call and an lsof per process.
 * The dashboard did that for every such pane on every build, before its
 * summary cache was consulted, and builds follow every store change as well as
 * the 3s refresh. The pre-release bug hunt measured twenty such panes at twenty
 * lsof runs every 3s, and 680 in 15s while one pane retitled itself twice a
 * second, up to 132 at once. So the dashboard reuses an answer for the same
 * agent, session and status for up to 15s, sharing one lookup between builds
 * that overlap. A status change is when a first transcript appears and when a
 * process moves on, so it looks again then; the reader and the transcript
 * watcher always look afresh for the pane someone has open, and the dashboard
 * reuses what they found.
 */
const locations = new Map<string, { key: string; at: number; source: Promise<TranscriptSource | null> }>();
const LOCATION_MAX_AGE_MS = 15_000;

// A person's choice counts as a session here, so choosing one is looked up at once.
// The title is left out on purpose, though a Codex pane's title can name its
// conversation (codex-log.ts `rolloutFromTitle`): a pane that retitled itself
// twice a second drove 680 process lookups in 15s. The reader and the
// transcript watcher look afresh, and a status change or 15s refresh this.
const locationKey = (pane: PaneInfo) => JSON.stringify([pane.terminal_id, pane.agent ?? null, agentSessionOf(pane) ?? choiceHeld(pane.pane_id), pane.agent_status]);

/** Where a pane's transcript is, looked up afresh: the reported session first, then the pane's process. */
export function transcriptSourceFor(pane: PaneInfo, client?: HerdrClient): Promise<TranscriptSource | null> {
  // Never a session herdr kept after its agent left the pane (see herdr-pane.ts).
  const id = agentSessionOf(pane);
  const source = pane.agent === "cursor" ? (client ? cursorTranscriptFor(client, pane.pane_id, id) : Promise.resolve(null))
    : pane.agent === "codex" ? (client ? findCodexRollout(client, pane.pane_id, pane.cwd ?? null, id,
      { title: pane.terminal_title_stripped ?? pane.terminal_title ?? null, folder: pane.foreground_cwd ?? pane.cwd ?? null }) : Promise.resolve(null))
    : pane.agent === "agy" ? (client ? antigravityTranscriptFor(client, pane.pane_id, id) : Promise.resolve(null))
    : pane.agent === "opencode" ? (id ? findOpenCodeTranscript(id) : Promise.resolve(null))
    : pane.agent === "claude" ? claudeTranscriptFor(pane, client, id) : Promise.resolve(null);
  locations.set(pane.pane_id, { key: locationKey(pane), at: Date.now(), source: source.catch(() => null) });
  return source;
}

/**
 * The background job the pane's Claude parked its conversation in, which the
 * pane shows (claude-choice.ts, `parkedSession`); then Claude's reported
 * session; then the one a person chose for this process.
 */
async function claudeTranscriptFor(pane: PaneInfo, client: HerdrClient | undefined, id: string | null): Promise<string | null> {
  const session = await parkedSession(client, pane) ?? id ?? await chosenSession(client, pane);
  const path = session ? await findTranscript(session) : null;
  return path ? continuedTranscript(path) : null;
}

/** File-only compatibility for callers that need actual bytes, such as Codex images. */
export async function transcriptPathFor(pane: PaneInfo, client?: HerdrClient): Promise<string | null> {
  const source = await transcriptSourceFor(pane, client);
  return typeof source === "string" ? source : null;
}

/** The dashboard's lookup: see `locations`. */
function locate(pane: PaneInfo, client?: HerdrClient): Promise<TranscriptSource | null> {
  const held = locations.get(pane.pane_id);
  if (held && held.key === locationKey(pane) && Date.now() - held.at < LOCATION_MAX_AGE_MS) return held.source;
  return transcriptSourceFor(pane, client);
}

/** Reads a window of the transcript at `path` the way its agent writes it. */
async function readTranscript(path: TranscriptSource, kind: string | null | undefined, window: Window): Promise<SessionLog | null> {
  if (typeof path !== "string") return kind === "opencode" ? readOpenCodeLog(path, window) : null;
  if (kind === "cursor") return readCursorLog(path, window);
  if (kind === "codex") return readCodexLog(path, window);
  if (kind === "agy") return readAntigravityLog(path, window);
  if (kind && kind !== "claude") return null;
  // A Claude transcript is named after its session.
  const log = await readWindow(path, window);
  return log && { ...log, sessionId: basename(path, ".jsonl") };
}

/**
 * What a transcript's cached reads are checked against. Stat before reading,
 * so a write landing mid-read leaves an older version on the entry and the
 * next poll reads again, rather than the reverse.
 */
async function versionOf(path: TranscriptSource): Promise<{ version: string; mtimeMs: number }> {
  if (typeof path !== "string") return openCodeStamp(path);
  const file = await stat(path);
  return { version: `${file.ino}:${file.size}:${file.mtimeMs}`, mtimeMs: file.mtimeMs };
}

export function transcriptWatchSource(source: TranscriptSource): TranscriptWatchSource {
  if (typeof source === "string") return source;
  return {
    key: sourceKey(source),
    current: async () => {
      const state = await openCodeStamp(source);
      // Readers treat log_changed as an invalidation hint. Database revisions
      // have no meaningful byte offset; their modification time is the hint.
      return { version: state.version, offset: Math.floor(state.mtimeMs) };
    },
  };
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
    const path = await locate(pane, client);
    return path ? await transcriptSummary(pane.pane_id, path, pane.agent) : summaryOf(null);
  } catch { return summaryOf(null); }
}

/** The summary of the transcript at `path`, read again only when the file has changed. */
export async function transcriptSummary(paneId: string, path: TranscriptSource, kind?: string | null): Promise<Summary> {
  const { version, mtimeMs } = await versionOf(path);
  const held = summaries.get(paneId);
  const key = JSON.stringify([kind ?? "claude", sourceKey(path)]);
  if (held && held.path === key && held.version === version) return held.summary;
  const log = await readTranscript(path, kind, { limit: 3 });
  // Cursor does not record timestamps. Its exact transcript's modification
  // time is the best available fallback, and survives a sidecar restart.
  const summary = summaryOf(log, kind === "cursor" ? mtimeMs : null);
  summaries.set(paneId, { path: key, version, summary });
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
export async function transcriptPage(paneId: string, path: TranscriptSource, kind: string | null | undefined, window: Window): Promise<Page | null> {
  let version: string;
  try { ({ version } = await versionOf(path)); } catch { return null; }
  let held = pages.get(paneId);
  const identity = JSON.stringify([kind ?? "claude", sourceKey(path)]);
  if (!held || held.path !== identity || held.version !== version) {
    held = { path: identity, version, windows: new Map() };
    pages.set(paneId, held);
  }
  const key = `${window.limit ?? ""}:${window.before ?? ""}`;
  const cached = held.windows.get(key);
  if (cached) {
    held.windows.delete(key);
    held.windows.set(key, cached);
    return cached;
  }
  const read = await readTranscript(path, kind, window);
  if (!read) return null;
  // Claude's task list rides on the tail, the page every poll asks for; an
  // earlier page is history, and a list on it would be the current one anyway.
  const tasks = (kind ?? "claude") === "claude" && window.before === undefined && read.sessionId ? await claudeTasks(read.sessionId) : undefined;
  // Bounded in bytes as well as messages, or one huge message in the window
  // is a 413 through the relay on every poll (`fitPage`). Before the ETag, so
  // the tag names what is sent.
  const log = fitPage(tasks?.length ? { ...read, tasks } : read);
  const page = { log, etag: `W/"${Bun.hash(JSON.stringify(log)).toString(36)}"` };
  // Kept only if no newer version of the file replaced the entry meanwhile.
  if (pages.get(paneId) === held) {
    // A provider's index can be evicted independently of these page windows.
    // Cursor/Antigravity rebuild with a fresh boundary even if the file's
    // stat is unchanged. Never leave the tail cached under its old boundary:
    // clients discard mismatched pagination and must recover on their next poll.
    if ([...held.windows.values()].some(previous => previous.log.path !== log.path || previous.log.sessionId !== log.sessionId)) held.windows.clear();
    held.windows.set(key, page);
    for (const old of [...held.windows.keys()].slice(0, Math.max(0, held.windows.size - MAX_WINDOWS_PER_PANE))) held.windows.delete(old);
  }
  return page;
}

/** Forgets the summaries, pages and transcript locations of panes that no longer exist. */
export function retainSummaries(paneIds: Iterable<string>): void {
  const live = new Set(paneIds);
  for (const cache of [summaries, pages, locations]) {
    for (const paneId of cache.keys()) if (!live.has(paneId)) cache.delete(paneId);
  }
}

export function summaryOf(log: SessionLog | null, fallbackAt: number | null = null): Summary {
  const messages = log?.messages ?? [];
  const at = messages.at(-1)?.at || (messages.length ? fallbackAt : null);
  return { preview: previewOf(messages), lastMessageAt: at && Number.isFinite(at) && at > 0 ? at : null };
}
