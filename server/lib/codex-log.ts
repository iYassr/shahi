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
 * **The transcript has two views of the same conversation, and one is mostly a
 * trap.** `response_item` records are the raw API turns. Their `message` and
 * `reasoning` subtypes include `developer`-role system prompts and an
 * `<environment_context>` block sent as a user turn; rendering those would put
 * codex's own instructions in your mouth — the same mistake as attributing
 * Claude's `tool_result` records to the user. So the conversation text is taken
 * from `event_msg`, the UI-level view already stripped to what a person said
 * and what the agent replied.
 *
 * The exception is tool activity, which lives *only* in `response_item` and
 * nowhere in `event_msg`: `function_call` / `custom_tool_call` and their
 * matching `*_output` records. Dropping those meant a codex conversation read
 * as if the agent talked but never ran anything. These subtypes are
 * unambiguously tool calls — there is no developer-prompt ambiguity — so the
 * reader now renders them as the same `tool` blocks the Claude reader produces,
 * pairing a call to its output by `call_id`. The two shapes were captured live
 * (codex 2026.07.18.1); the fixtures in the test file are those captures.
 */
import { Database } from "bun:sqlite";
import { open, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { HerdrClient } from "./herdr-client";
import type { Block, LogMessage, SessionLog } from "./session-log";

/** Tool output can be enormous; the phone gets a readable slice — matching the Claude reader. */
const MAX_RESULT_CHARS = 2_000;

/** The `response_item` subtypes that are a tool being invoked. */
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
/** …and the ones carrying that call's result, joined back by `call_id`. */
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
/** A path as the filesystem knows it, or unchanged if it does not exist yet. */
function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
// Kept as spelt: the glob route joins matches onto it and callers expect that
// spelling back. Whether a path is *inside* it is decided on resolved paths in
// `rolloutWithinSessions`, because codex canonicalises CODEX_HOME and stores
// real paths in its index while this would be the symlink (review finding).
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
 * A path the thread index or a process handed back, if it is a rollout.
 *
 * The index is a file codex writes and a session id is a value the agent
 * process reports, so neither is this server's to trust with a path. The
 * `/proc` route already required a rollout under the sessions directory;
 * this holds the two index routes to the same rule, so the worst a doctored
 * `rollout_path` can do is name a different rollout.
 */
export function rolloutWithinSessions(path: unknown, sessionsDir = SESSIONS_DIR): string | null {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return null;
  // Compared as resolved paths: `resolve` folds any `..` away and `realpath`
  // follows a symlinked directory, so the check is on where the file actually
  // is rather than on how it was spelt.
  const resolved = resolve(path);
  const candidate = join(realpathIfExists(dirname(resolved)), basename(resolved));
  return candidate.startsWith(`${realpathIfExists(sessionsDir)}/`) ? path : null;
}

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
    const indexed = rolloutWithinSessions(row?.rollout_path);
    if (indexed) return indexed;
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
        const target = rolloutWithinSessions(await readlink(`/proc/${pid}/fd/${fd}`));
        if (target) return target;
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
    return rolloutWithinSessions(row?.rollout_path);
  } catch {
    return null;
  }
}

/** The non-null half of a `tool` block's `result`, extracted for reuse. */
type ToolResult = NonNullable<(Block & { kind: "tool" })["result"]>;

/**
 * An MCP tool call, from an `mcp_tool_call_end` event. Its `invocation` names
 * the server and tool and carries the arguments; its `result` is the MCP
 * `{ Ok }` / `{ Err }` union, whose text (or error) becomes the tool result.
 */
function mcpToolBlock(payload: Record<string, unknown>): Block & { kind: "tool" } {
  const inv = (payload.invocation as Record<string, unknown> | undefined) ?? {};
  const server = typeof inv.server === "string" ? inv.server : "";
  const tool = typeof inv.tool === "string" ? inv.tool : "tool";
  const args = inv.arguments as Record<string, unknown> | undefined;
  const title = args && typeof args.title === "string" ? args.title : undefined;
  return {
    kind: "tool",
    name: server ? `${server}.${tool}` : tool,
    summary: title ?? firstArg(args) ?? tool,
    result: mcpResult(payload.result),
  };
}

/**
 * A file edit from codex's native `apply_patch`. Unlike a shell `apply_patch`
 * heredoc — which arrives as a `custom_tool_call` and is rendered like any exec
 * — the native tool is recorded *only* as a `patch_apply_end` event with no
 * matching `response_item`, so without this branch a codex session that edits
 * with the built-in patcher reads as if it never touched a file. The `changes`
 * map names each path and how it changed; the summary is that list, the result
 * is the tool's own stdout.
 */
function patchApplyBlock(payload: Record<string, unknown>): Block & { kind: "tool" } {
  const changes = (payload.changes as Record<string, { type?: string }> | undefined) ?? {};
  const parts = Object.entries(changes).map(([path, c]) => `${c?.type ?? "edit"} ${basename(path)}`);
  const stdout = typeof payload.stdout === "string" ? payload.stdout.trim() : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr.trim() : "";
  const text = [stdout, stderr].filter(Boolean).join("\n");
  return {
    kind: "tool",
    name: "apply_patch",
    summary: parts.join(", ") || "apply_patch",
    result: text ? { text: cap(text), isError: payload.success === false, truncated: text.length > MAX_RESULT_CHARS, images: [] } : null,
  };
}

/** The text (or error) inside an MCP `{ Ok: { content } }` / `{ Err }` result. */
function mcpResult(result: unknown): ToolResult | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { Ok?: { content?: unknown }; Err?: unknown };
  if (r.Err !== undefined) {
    const text = typeof r.Err === "string" ? r.Err : JSON.stringify(r.Err);
    return { text: cap(text), isError: true, truncated: text.length > MAX_RESULT_CHARS, images: [] };
  }
  const content = r.Ok?.content;
  const text = Array.isArray(content)
    ? content
        .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
        .join("")
    : typeof content === "string"
      ? content
      : "";
  return { text: cap(text), isError: false, truncated: text.length > MAX_RESULT_CHARS, images: [] };
}

/** A short label from an MCP call's arguments when it named no title. */
function firstArg(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]!.slice(0, 160);
  }
  return undefined;
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text;
}

/** codex tool output is either a plain string or a list of `input_text` parts. */
function codexResult(payload: Record<string, unknown>): ToolResult {
  const raw = payload.output;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")))
      .join("");
  }
  text = text.trim();
  const truncated = text.length > MAX_RESULT_CHARS;
  return {
    text: truncated ? `${text.slice(0, MAX_RESULT_CHARS)}\n…` : text,
    // codex does not flag errors in the rollout the way Claude's `is_error`
    // does; guessing from output text would mislabel ordinary stderr, so this
    // stays honest and leaves severity to the words.
    isError: false,
    truncated,
    images: [],
  };
}

/**
 * The one-line summary under a codex tool row.
 *
 * `custom_tool_call` (the `exec` tool) wraps the real command in a scrap of JS —
 * `tools.exec_command({"cmd":"wc -l note.txt", …})` — so the command is pulled
 * out of it. `function_call` carries a JSON `arguments` string; its `command`
 * is used when present, otherwise a compact rendering of the arguments. The
 * command is what a person scanning the conversation actually wants to see.
 */
export function summariseCodexCall(payload: Record<string, unknown>): string {
  const cmdIn = (s: string): string | null => {
    const m = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1] ?? null;
    }
  };

  if (typeof payload.input === "string") {
    return cmdIn(payload.input) ?? payload.input.trim().split("\n")[0]!.slice(0, 160);
  }
  if (typeof payload.arguments === "string") {
    try {
      const args = JSON.parse(payload.arguments) as Record<string, unknown>;
      if (typeof args.command === "string") return args.command;
      if (typeof args.cmd === "string") return args.cmd;
      const compact = JSON.stringify(args);
      return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
    } catch {
      return payload.arguments.slice(0, 160);
    }
  }
  return "";
}

/**
 * Turns rollout records into the same shape the Claude reader produces.
 *
 * Conversation text comes from `event_msg`. Tool activity comes from the
 * `function_call` / `custom_tool_call` subtypes of `response_item` — the only
 * place codex records it — rendered as `tool` blocks and paired to their output
 * by `call_id`. Every other `response_item` (developer prompts, the environment
 * context, reasoning, the duplicated assistant message) is left alone; see the
 * module note.
 */
export function normaliseCodex(rows: Record<string, unknown>[], firstIndex = 0): LogMessage[] {
  // Outputs follow their call in the file, so index them first, then a single
  // forward pass emits calls already knowing their result (or null if the tool
  // has not returned yet — the pending state the client already renders).
  const outputs = new Map<string, ToolResult>();
  for (const row of rows) {
    if (row.type !== "response_item") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (payload && TOOL_OUTPUT_TYPES.has(payload.type as string) && typeof payload.call_id === "string") {
      outputs.set(payload.call_id, codexResult(payload));
    }
  }

  const messages: LogMessage[] = [];

  for (const [relativeIndex, row] of rows.entries()) {
    const index = firstIndex + relativeIndex;
    const at = Date.parse((row.timestamp as string) ?? "") || 0;

    if (row.type === "event_msg") {
      const payload = row.payload as Record<string, unknown> | undefined;
      const kind = payload?.type as string | undefined;

      // Codex 0.153 replaced the UI-level `user_message` / `agent_message`
      // events with one `item_completed` event whose item is the public
      // conversation object. Keep reading the UI-level representation rather
      // than raw response_item messages: those still contain developer prompts
      // and synthetic environment context alongside the real conversation.
      if (kind === "item_completed") {
        const item = payload?.item as Record<string, unknown> | undefined;
        if (!item) continue;
        const itemType = item?.type;
        const role = itemType === "UserMessage" ? "you" : itemType === "AgentMessage" ? "agent" : null;
        if (!role) continue;
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const value = part as Record<string, unknown>;
            return typeof value.text === "string" ? value.text : "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!text) continue;
        messages.push({
          id: typeof item.id === "string" ? item.id : `codex-${index}`,
          role,
          at,
          blocks: [{ kind: "text", text }],
        });
        continue;
      }

      // Reasoning. codex streams it as `agent_reasoning` events carrying
      // plaintext — the matching `response_item` of type `reasoning` is
      // encrypted, so this is the only place its text exists (measured: 335
      // agent_reasoning events across the real rollouts, all dropped before).
      // A run of them is coalesced into one thinking block, the way Claude
      // writes a single block per turn, so the reader is not a stack of
      // one-line headers.
      if (kind === "agent_reasoning" || kind === "agent_reasoning_raw_content") {
        const text = (payload?.text as string | undefined)?.trim();
        if (!text) continue;
        const last = messages[messages.length - 1];
        const lastBlock = last?.blocks[0];
        if (last && last.role === "agent" && last.blocks.length === 1 && lastBlock?.kind === "thinking") {
          last.blocks[0] = { kind: "thinking", text: `${lastBlock.text}

${text}` };
        } else {
          messages.push({ id: `codex-${index}`, role: "agent", at, blocks: [{ kind: "thinking", text }] });
        }
        continue;
      }

      // MCP and web-search tool activity lives only in `event_msg`, never as a
      // `response_item`, so it is read here (measured: 334 mcp_tool_call_end
      // events dropped before). The `_end` event carries the full invocation
      // and result; the `_begin` is redundant and skipped.
      if (kind === "mcp_tool_call_end") {
        messages.push({ id: `codex-${index}`, role: "agent", at, blocks: [mcpToolBlock(payload!)] });
        continue;
      }
      // A native apply_patch edit — recorded only here, never as a
      // response_item (a shell `apply_patch` heredoc is the custom_tool_call
      // path instead). The `_end` carries the changes and stdout; `_begin` is
      // skipped as redundant, the same way mcp `_begin` is.
      if (kind === "patch_apply_end") {
        messages.push({ id: `codex-${index}`, role: "agent", at, blocks: [patchApplyBlock(payload!)] });
        continue;
      }
      if (kind === "web_search_end") {
        const q = (payload?.query as string | undefined)?.trim();
        messages.push({
          id: `codex-${index}`,
          role: "agent",
          at,
          blocks: [{ kind: "tool", name: "web_search", summary: q ?? "web search", result: null }],
        });
        continue;
      }

      // Conversation text. task_started, task_complete, token_count and
      // anything codex adds later are lifecycle, not conversation.
      const text = (payload?.message as string | undefined)?.trim();
      if (!text) continue;
      const role = kind === "user_message" ? "you" : kind === "agent_message" ? "agent" : null;
      if (!role) continue;
      messages.push({ id: `codex-${index}`, role, at, blocks: [{ kind: "text", text }] });
      continue;
    }

    if (row.type === "response_item") {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload || !TOOL_CALL_TYPES.has(payload.type as string)) continue;

      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      messages.push({
        id: `codex-${index}`,
        role: "agent",
        at,
        blocks: [
          {
            kind: "tool",
            name: typeof payload.name === "string" ? payload.name : "tool",
            summary: summariseCodexCall(payload),
            result: (callId && outputs.get(callId)) || null,
          },
        ],
      });
    }
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

  try {
    const log = await readCodexWindow(path, options);
    return { ...log, sessionId: basename(path).replace(/\.jsonl$/, "") || paneId };
  } catch {
    return null;
  }
}

interface RowRange { start: number; end: number; ordinal: number }
interface MessageRange { rows: RowRange[]; thinking: boolean; callId?: string }
interface CodexIndex {
  size: number;
  fileSize: number;
  ino: number;
  mtime: number;
  ctime: number;
  rows: number;
  messages: MessageRange[];
  outputs: Map<string, RowRange>;
}
const codexIndexes = new Map<string, CodexIndex>();
const codexReads = new Map<string, Promise<unknown>>();
const MAX_CODEX_INDEXES = 64;

/** Optional content-free diagnostics used to verify the reader's I/O budget. */
export interface CodexReadStats { indexedBytes: number; windowBytes: number; parsedRows: number }

/** Serialize each file's reads so concurrent polls cannot append the same index twice. */
export async function readCodexWindow(
  path: string,
  options: { limit?: number; before?: number; stats?: CodexReadStats } = {},
): Promise<SessionLog> {
  const previous = codexReads.get(path) ?? Promise.resolve();
  const read = previous.catch(() => {}).then(() => readIndexedCodexWindow(path, options));
  codexReads.set(path, read);
  try { return await read; }
  finally { if (codexReads.get(path) === read) codexReads.delete(path); }
}

async function readIndexedCodexWindow(
  path: string,
  options: { limit?: number; before?: number; stats?: CodexReadStats },
): Promise<SessionLog> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const held = codexIndexes.get(path);
    // An inode replacement, shrink, or same-sized rewrite invalidates offsets.
    const index: CodexIndex = held && held.ino === stat.ino && stat.size >= held.fileSize &&
      (stat.size !== held.fileSize || (held.mtime === stat.mtimeMs && held.ctime === stat.ctimeMs))
      ? held
      : { size: 0, fileSize: 0, ino: stat.ino, mtime: 0, ctime: 0, rows: 0, messages: [], outputs: new Map() };
    // Do not retain a partly updated index if reading fails.
    codexIndexes.delete(path);
    const stats = options.stats;
    let cursor = index.size;
    let pending = Buffer.alloc(0);
    while (cursor < stat.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - cursor));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, cursor);
      if (!bytesRead) break;
      cursor += bytesRead;
      if (stats) stats.indexedBytes += bytesRead;
      const buffer = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
        const range = { start: index.size, end: index.size + end - start + 1, ordinal: index.rows };
        const line = buffer.subarray(start, end).toString("utf8");
        index.size = range.end;
        start = end + 1;
        let row: Record<string, unknown>;
        try { row = JSON.parse(line); } catch { continue; }
        index.rows++;
        if (stats) stats.parsedRows++;
        const payload = row?.payload as Record<string, unknown> | undefined;
        if (row?.type === "response_item" && payload && TOOL_OUTPUT_TYPES.has(payload.type as string) && typeof payload.call_id === "string") {
          index.outputs.set(payload.call_id, range);
        }
        const message = normaliseCodex([row], range.ordinal)[0];
        if (!message) continue;
        const thinking = message.blocks[0]?.kind === "thinking";
        const last = index.messages.at(-1);
        if (thinking && last?.thinking) last.rows.push(range);
        else index.messages.push({ rows: [range], thinking, callId: row.type === "response_item" && typeof payload?.call_id === "string" ? payload.call_id : undefined });
      }
      pending = buffer.subarray(start);
    }
    index.fileSize = stat.size;
    index.mtime = stat.mtimeMs;
    index.ctime = stat.ctimeMs;
    codexIndexes.set(path, index);
    while (codexIndexes.size > MAX_CODEX_INDEXES) codexIndexes.delete(codexIndexes.keys().next().value!);

    const total = index.messages.length;
    const end = Math.min(total, Math.max(0, options.before ?? total));
    const start = Math.max(0, end - Math.max(0, options.limit ?? 200));
    const readRow = async (range: RowRange): Promise<Record<string, unknown>> => {
      const buffer = Buffer.alloc(range.end - range.start);
      let consumed = 0;
      while (consumed < buffer.length) {
        const { bytesRead } = await file.read(buffer, consumed, buffer.length - consumed, range.start + consumed);
        if (!bytesRead) throw new Error("Codex rollout changed during read");
        consumed += bytesRead;
      }
      if (stats) { stats.windowBytes += consumed; stats.parsedRows++; }
      return JSON.parse(buffer.toString("utf8"));
    };
    const messages: LogMessage[] = [];
    for (const message of index.messages.slice(start, end)) {
      let combined: LogMessage | undefined;
      const output = message.callId ? index.outputs.get(message.callId) : undefined;
      for (const range of message.rows) {
        const rows = [await readRow(range)];
        if (output) rows.push(await readRow(output));
        const parsed = normaliseCodex(rows, range.ordinal)[0]!;
        if (!combined) combined = parsed;
        else {
          const block = combined.blocks[0];
          const next = parsed.blocks[0];
          if (block?.kind === "thinking" && next?.kind === "thinking") block.text += `\n\n${next.text}`;
        }
      }
      if (combined) messages.push(combined);
    }
    return { sessionId: path, path, messages, total, offset: index.size };
  } finally { await file.close(); }
}
