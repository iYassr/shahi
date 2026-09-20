import { stat } from "node:fs/promises";
import type { HerdrClient } from "./herdr-client";
import type { PaneInfo } from "./herdr-schema";
import { readCodexLog } from "./codex-log";
import { cursorTranscriptFor, readCursorLog } from "./cursor-log";
import { previewOf, readSessionLog, type SessionLog } from "./session-log";

/** Reuses indexed transcript tails, never terminal repaint times or another session. */
export async function conversationSummary(pane: PaneInfo, client?: HerdrClient) {
  try {
    const kind = pane.agent;
    const id = pane.agent_session?.value;
    const path = kind === "cursor" && client ? await cursorTranscriptFor(client, pane.pane_id, id) : null;
    const log = kind === "cursor" ? path ? await readCursorLog(path, { limit: 3 }) : null
      : kind === "codex" ? client ? await readCodexLog(client, pane.pane_id, pane.cwd ?? null, { limit: 3, sessionId: id }) : null
      : id ? await readSessionLog(id, { limit: 3 }) : null;
    const messages = log?.messages ?? [];
    const last = messages.at(-1);
    // Cursor does not record timestamps. Its exact transcript's modification
    // time is the best available fallback, and survives a sidecar restart.
    const at = last?.at || (last && path ? (await stat(path)).mtimeMs : null);
    return summaryOf(log, at);
  } catch { return { preview: null, lastMessageAt: null }; }
}

export function summaryOf(log: SessionLog | null, fallbackAt: number | null = null) {
  const messages = log?.messages ?? [];
  const at = messages.at(-1)?.at || (messages.length ? fallbackAt : null);
  return { preview: previewOf(messages), lastMessageAt: at && Number.isFinite(at) && at > 0 ? at : null };
}
