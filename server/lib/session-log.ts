/**
 * Reads Claude Code's own session transcripts.
 *
 * This is the reader view's whole reason for existing. herdr can only hand back
 * a rendered terminal screen — pre-wrapped at the server's width, 42 rows deep,
 * with no scrollback — so anything built on it is screen-scraping a redrawing
 * TUI. But Claude Code independently writes a structured JSONL transcript per
 * session under `~/.claude/projects/`, and herdr's `agent_session.value` is
 * exactly that file's name. Verified on a live pane: `w4:p1` reports session
 * `bf68bbfd-…`, and `bf68bbfd-….jsonl` is right there.
 *
 * So the reader view is a file tail plus a renderer, with no parsing of terminal
 * output at all. The file is appended as the session runs (measured: +8KB in 12
 * seconds on a live session), which makes it tailable rather than merely
 * historical.
 *
 * What the format actually contains, measured across 48 transcripts and 8,298
 * records rather than assumed:
 *
 *   - **87% of `user` records are not from the user.** 1,509 of 1,736 carry
 *     nothing but `tool_result` blocks, because that is how tool output returns
 *     through the API. Rendering `type: "user"` as "you said" would attribute
 *     the overwhelming majority of tool output to the human.
 *   - `assistant` records carry `text`, `thinking`, and `tool_use` blocks.
 *   - `tool_result.content` comes as a string, or a list of `text` / `image` /
 *     `tool_reference` parts.
 *   - Slash commands arrive as `<command-name>` / `<command-args>` inside user
 *     text, with their output in `<local-command-stdout>`.
 *   - `isMeta: true` marks slash-command expansions written for the model.
 *
 * Only Claude Code writes this. `codex`, `pi` and `opencode` each keep their own
 * store in their own format, and plain shells have no transcript at all — so
 * the terminal view remains the universal fallback rather than a legacy one.
 */
import type { LogBlock, LogMessage, SessionLog } from "@shahi/shared";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Tool output can be enormous; the phone gets a readable slice. */
const MAX_RESULT_CHARS = 2_000;

/** The `system` subtypes whose top-level `content` is real, user-visible text. */
const SYSTEM_NOTE_SUBTYPES = new Set(["away_summary", "model_refusal_fallback"]);

/** `Block` is the local name for the contract's `LogBlock`. */
export type Block = LogBlock;
export type { LogMessage, SessionLog };




/* -------------------------------------------------------------------------- */

/**
 * Finds a session's transcript.
 *
 * Globs on the session id rather than deriving the project directory from a
 * cwd. Claude Code encodes the path into the directory name (`/home/x/Proj` ->
 * `-home-x-Proj`), and a session that moved directory, or a cwd that does not
 * round-trip through that encoding, would simply not be found. The id is a
 * UUID, so a scan is unambiguous.
 */
export async function findTranscript(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;

  let projects: string[];
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const project of projects) {
    const candidate = join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this project; keep looking.
    }
  }
  return null;
}

/**
 * An index of where each message starts, so a poll reads a window and not a file.
 *
 * The reader polls the tail every 2.5 seconds and asks for twelve messages. This
 * used to answer by parsing the entire transcript and slicing the end off it,
 * which was reasonable when the largest file here was 4.9MB and 516 messages.
 * That directory now holds 489MB, with single files at 38 and 50MB and one pane
 * reporting 2,310 messages, and the cost had become 208MB of resident memory to
 * show twelve of them — measured live, 74MB to 282MB on opening one pane.
 *
 * What is held now is the byte offset of the line that produced each message:
 * two numbers per message rather than a parsed object, about 18KB where the
 * messages were 200MB. A window is served by reading that byte range and
 * parsing only it.
 *
 * Two properties of `normalise` are what make this sound, and both are worth
 * stating because the design rests on them:
 *
 *  - **Whether a row produces a message is a property of that row alone.** Only
 *    the tool_use/tool_result pairing looks across rows, and it decides what a
 *    message *contains*, never whether it exists. So the index is built with
 *    `normalise([row]).length` rather than a second copy of that logic, which
 *    could drift from it.
 *  - **An orphaned `tool_result` is already dropped.** A user row carrying only
 *    a tool_result whose call is outside the window produces no blocks, and a
 *    message with no blocks is skipped. A window can therefore start anywhere
 *    without rendering half a tool call.
 *
 * The index extends rather than rebuilds: a live transcript grows by a few lines
 * between polls, and only those bytes are read. Anything else means a different
 * file wearing the same name, and that one starts over; `indexStillHolds` says
 * which is which.
 */
interface TranscriptIndex extends IndexedFile {
  /** Byte offset of the line that produced each message, in order. */
  offsets: number[];
}

/** What an index remembers of the file it read, to tell an append from a rewrite next time. */
export interface IndexedFile {
  /** Bytes indexed so far — always the end of the last complete line. */
  size: number;
  /** The file's inode, size and times when it was last read. */
  ino: number;
  fileSize: number;
  mtime: number;
  ctime: number;
  /** The last bytes indexed, up to `ANCHOR_BYTES`, ending at `size`. */
  anchor: Uint8Array;
}

/** The parts of a stat an index is checked against. */
type FileState = { ino: number; size: number; mtimeMs: number; ctimeMs: number };

/**
 * Enough to identify where an indexed line ends: a transcript line's last
 * fields are ids, a timestamp or the message's own words, which a rewrite does
 * not put back at the same offset.
 */
const ANCHOR_BYTES = 64;

/** An index of nothing yet, for the file as `now` describes it. */
export function emptyIndex(now: FileState): IndexedFile {
  return { size: 0, ino: now.ino, fileSize: now.size, mtime: now.mtimeMs, ctime: now.ctimeMs, anchor: new Uint8Array(0) };
}

/**
 * Whether an index still describes the file now at its path: `"same"` when
 * nothing has changed, `"grown"` when it can be extended from where it
 * stopped, `"other"` when it must be rebuilt.
 *
 * Offsets hold only while every byte they were read from is unchanged. A file
 * renamed over this one has another inode, and one shorter than what was
 * indexed was rewritten. The Claude index checked only the second, so a
 * rewrite that grew the file kept offsets into bytes that had moved: wrong
 * totals and the newest messages hidden (pre-release bug hunt, September
 * 2026). So a file whose size or times changed has its last indexed bytes read
 * again and compared: an append leaves them where they were. Unchanged size
 * and times cost no read at all, which is the common case of a quiet pane.
 */
export async function indexStillHolds(
  held: IndexedFile,
  now: FileState,
  read: (from: number, to: number) => Promise<Uint8Array>,
): Promise<"same" | "grown" | "other"> {
  if (now.ino !== held.ino || now.size < held.size) return "other";
  if (now.size === held.fileSize && now.mtimeMs === held.mtime && now.ctimeMs === held.ctime) return "same";
  const bytes = await read(held.size - held.anchor.length, held.size);
  return Buffer.compare(bytes, held.anchor) === 0 ? "grown" : "other";
}

/** The last `ANCHOR_BYTES` of `before` followed by `after`, copied so no read buffer is retained. */
export function anchorAfter(before: Uint8Array, after: Uint8Array): Uint8Array {
  if (after.length >= ANCHOR_BYTES) return after.slice(after.length - ANCHOR_BYTES);
  return concat(before, after).slice(-ANCHOR_BYTES);
}

/** Indexes are small; this bound is a backstop, not a working constraint. */
const MAX_INDEXES = 64;

const indexes = new Map<string, TranscriptIndex>();

/**
 * Reads whole lines from `from`, returning the offset after the last complete
 * one and the anchor that ends there (`anchor` is the one ending at `from`).
 *
 * The last line of a live transcript is often half-written, so anything after
 * the final newline is left unconsumed and picked up on the next pass. Splitting
 * on bytes is safe: `\n` cannot appear inside a UTF-8 multi-byte sequence.
 *
 * Hand-rolled rather than `node:readline` because the byte offset of each line
 * is the whole point, and readline hands back decoded strings — whose lengths
 * are characters, not bytes, and so cannot be added up to seek by.
 */
async function scanLines(
  path: string,
  from: number,
  onRow: (offset: number, row: Record<string, unknown>) => void,
  anchor: Uint8Array = new Uint8Array(0),
): Promise<{ end: number; anchor: Uint8Array }> {
  const decoder = new TextDecoder();
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let consumed = from;

  for await (const chunk of Bun.file(path).slice(from).stream()) {
    const buffer: Uint8Array<ArrayBuffer> =
      pending.length === 0 ? (chunk as Uint8Array<ArrayBuffer>) : concat(pending, chunk);
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0x0a) continue;
      const line = decoder.decode(buffer.subarray(start, i));
      if (line.trim()) {
        try {
          const row: unknown = JSON.parse(line);
          if (isRecord(row)) onRow(consumed + start, row);
        } catch {
          // A partially-written line, or one this version cannot read. Skipping
          // it costs one message; failing the read costs the whole transcript.
        }
      }
      start = i + 1;
    }
    // Taken from the bytes just scanned rather than read again afterwards, so
    // it can only ever describe the file these offsets came from.
    if (start > 0) anchor = anchorAfter(anchor, buffer.subarray(0, start));
    consumed += start;
    pending = buffer.subarray(start);
  }
  return { end: consumed, anchor };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The index being built or extended for each path, so reads of one file take turns. */
const indexing = new Map<string, Promise<TranscriptIndex>>();

/**
 * Builds the index, or extends the one already held, up to the file's end.
 *
 * One at a time per file. The dashboard's broadcast, its 3s refresh and the
 * reader's poll overlap, and two extending the same index at once each
 * appended the same new rows: the bug hunt saw 30 offsets for 25 messages and
 * a 12-message tail that showed 7. Setting the index aside while it is
 * extended would only turn the others into full re-reads of the transcript.
 * The Codex reader already took turns.
 */
export function indexTranscript(path: string, normalizer = normalise): Promise<TranscriptIndex> {
  const next = (indexing.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => extendIndex(path, normalizer));
  indexing.set(path, next);
  const done = () => { if (indexing.get(path) === next) indexing.delete(path); };
  next.then(done, done);
  return next;
}

async function extendIndex(path: string, normalizer: (rows: Record<string, unknown>[]) => LogMessage[]): Promise<TranscriptIndex> {
  const now = await stat(path);
  const held = indexes.get(path);
  // Not kept half-extended if the read below fails; the next one starts over.
  indexes.delete(path);

  const verdict = held
    ? await indexStillHolds(held, now, (from, to) => Bun.file(path).slice(from, to).bytes())
    : "other";
  const index: TranscriptIndex = held && verdict !== "other" ? held : { ...emptyIndex(now), offsets: [] };

  if (verdict !== "same") {
    const scanned = await scanLines(path, index.size, (offset, row) => {
      if (normalizer([row]).length > 0) index.offsets.push(offset);
    }, index.anchor);
    index.size = scanned.end;
    index.anchor = scanned.anchor;
    // As stated before the scan: bytes appended during it only make the next
    // read compare the anchor, which is the safe direction.
    index.fileSize = now.size;
    index.mtime = now.mtimeMs;
    index.ctime = now.ctimeMs;
  }

  indexes.set(path, index);
  for (const key of [...indexes.keys()].slice(0, Math.max(0, indexes.size - MAX_INDEXES))) {
    indexes.delete(key);
  }
  return index;
}


/**
 * One line for a chat-style list row: the last thing said, flattened.
 *
 * The last text block of the last message wins; a message that is nothing but
 * tool calls previews as the call ("Edit · pane.tsx"), which reads better than
 * silence. "You: " marks the human's own words, the way every messenger does.
 */
export function previewOf(messages: LogMessage[]): string | null {
  const last = messages.at(-1);
  if (!last) return null;

  const blocks = [...last.blocks].reverse();
  const text = blocks.find((b) => b.kind === "text" && b.text.trim().length > 0);
  const tool = blocks.find((b) => b.kind === "tool");
  const line =
    text?.kind === "text"
      ? text.text
      : tool?.kind === "tool"
        ? `${tool.name} · ${tool.summary}`
        : null;
  if (!line) return null;

  const flat = line.replace(/[#*`_>]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!flat) return null;
  return last.role === "you" ? `You: ${flat}` : flat;
}

/**
 * Messages beyond the window, read so the last tool call in it can still find
 * its result. Its `tool_result` is in a later row, and without a few rows of
 * slack the newest call in a page would render without its output.
 */
const PAIRING_SLACK = 4;

/** Reads and normalises a window of a transcript, newest messages last. */
export async function readWindow(
  path: string,
  options: { limit?: number; before?: number } = {},
  normalizer: (rows: Record<string, unknown>[], start?: number) => LogMessage[] = normalise,
): Promise<SessionLog | null> {
  const index = await indexTranscript(path, normalizer);
  const total = index.offsets.length;

  const limit = options.limit ?? 200;
  const end = Math.min(options.before ?? total, total);
  const start = Math.max(0, end - limit);

  // Reading from the line that produced message `start` means the first message
  // parsed out of the range is exactly that one, so the slice below only has to
  // drop the slack read for pairing.
  const from = index.offsets[start] ?? 0;
  const beyond = end + PAIRING_SLACK;
  const to = beyond < total ? index.offsets[beyond] : undefined;

  const window = await Bun.file(path).slice(from, to).text();
  const messages = normaliseReadable(parseLines(window), start, normalizer).slice(0, end - start);

  return { sessionId: path, path, messages, total, offset: index.size };
}

/**
 * A window's messages under the index's rule: a row the normaliser throws on
 * costs that row. The index never counted such a row, so the page must drop
 * it too, both to agree with the index's offsets and because handing it to
 * the one call below failed every page that covered it with a 500
 * (pre-release bug hunt, September 2026). Rows are tried one at a time only
 * once the whole window has thrown, so a readable window costs one call.
 */
function normaliseReadable(
  rows: Record<string, unknown>[],
  start: number,
  normalizer: (rows: Record<string, unknown>[], start?: number) => LogMessage[],
): LogMessage[] {
  try {
    return normalizer(rows, start);
  } catch {
    const readable = rows.filter((row) => {
      try { normalizer([row]); return true; } catch { return false; }
    });
    return normalizer(readable, start);
  }
}

/**
 * Names the transcript a log came from and makes its message ids unique to it.
 *
 * Codex and Cursor number messages by their position in the file, so every
 * transcript has a message 0. Both clients merge a fresh page into the pane's
 * cached messages by id, and a herdr pane outlives the conversation in it: a
 * new Cursor chat in the same pane kept the old chat's messages on the phone,
 * and the web reader showed both sessions as one thread (review finding,
 * September 2026). Ids scoped by `sessionId` never match across transcripts,
 * so a switch takes each client's existing no-overlap reset. `sessionId`
 * itself changes whenever the transcript does, for clients that compare it.
 * Claude needs none of this: its ids are the records' own UUIDs.
 */
export function inTranscript(log: SessionLog, sessionId: string): SessionLog {
  return { ...log, sessionId, messages: log.messages.map((message) => ({ ...message, id: `${sessionId}:${message.id}` })) };
}

/**
 * The complete lines of a transcript that are objects.
 *
 * Only objects: a line that is valid JSON but a bare `null`, number or list is
 * a row of no shape any reader knows. The index already skipped one, and this
 * handing it to the normaliser failed every page that covered it (pre-release
 * bug hunt, September 2026).
 */
export function parseLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row)) rows.push(row);
    } catch {
      // A partially-written final line is normal while tailing a live session.
    }
  }
  return rows;
}

/** A JSON object, as opposed to `null`, a list or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field's value if it is a string, for reading a file an agent wrote. */
export function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/* -------------------------------------------------------------------------- */

/**
 * A content block as the file has it. Nothing about its fields is known until
 * each is checked: the file is written by another program, and a field of an
 * unexpected type is a shape this reader does not know, so it is dropped.
 */
type RawBlock = Record<string, unknown>;

/**
 * Turns raw records into renderable messages.
 *
 * The important move is pairing: a `tool_use` in an assistant record and its
 * `tool_result` in the following user record are one event to a reader, so they
 * are merged into a single block. Doing otherwise produces a transcript that
 * alternates between the agent calling a tool and the "user" replying with its
 * output, which is both wrong and unreadable.
 *
 * Every field is type-checked before it is read. Thinking given as an object
 * or a `null` content block used to throw here, and one such row failed every
 * page that covered it (pre-release bug hunt, September 2026).
 */
export function normalise(rows: Record<string, unknown>[]): LogMessage[] {
  // First pass: collect every tool result so a call can carry its own output.
  const results = new Map<
    string,
    { text: string; isError: boolean; truncated: boolean; images: string[] }
  >();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    let resultImage = 0;
    for (const block of blocksOf(row)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id) {
        results.set(block.tool_use_id, flattenResult(block, stringOr(row.uuid, null), () => resultImage++));
      }
    }
  }

  const messages: LogMessage[] = [];

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) continue;
    const type = row.type;
    const id = stringOr(row.uuid, `row-${index}`);
    const at = Date.parse(stringOr(row.timestamp, "")) || 0;

    // A few `system` records carry real content the person saw, in a top-level
    // string rather than in `message.content`, so they were dropped — shown now
    // as system notes. The set is an explicit allowlist, not "any system
    // record", because most system subtypes (turn_duration, compact_boundary,
    // informational "Backgrounding…") are ephemeral chrome; the rule is still
    // "unknown shapes are dropped, never guessed". The two that count:
    //   - away_summary: Claude Code recounting what it did while you were gone.
    //   - model_refusal_fallback: a safeguard flagged a message and switched
    //     models mid-session; its `content` explains the switch the user saw.
    // (measured across the real transcripts: 82 and 2.)
    if (type === "system" && SYSTEM_NOTE_SUBTYPES.has(row.subtype as string) && typeof row.content === "string" && row.content.trim()) {
      messages.push({ id, role: "system", at, blocks: [{ kind: "text", text: row.content.trim() }] });
      continue;
    }

    if (type !== "user" && type !== "assistant") continue;

    // Slash-command expansions are written for the model, not the reader. So is
    // the summary Claude Code writes after /compact or auto-compaction: a user
    // row flagged `isCompactSummary`, 14-19KB of "This session is being
    // continued…" handoff that rendered as a message the person typed and took
    // over the list preview (review finding, September 2026; 4 rows in the
    // local corpus). The boundary itself, `compact_boundary`, is already chrome.
    if (row.isMeta === true || row.isCompactSummary === true) continue;

    const blocks: LogBlock[] = [];
    let imageIndex = 0;
    // A row that produced only chrome (a model switch) reads as a system note,
    // not as the agent speaking.
    let onlyNotes = true;
    const content = isRecord(row.message) ? row.message.content : undefined;

    if (typeof content === "string") {
      const rendered = renderUserText(content);
      if (rendered) blocks.push(rendered);
    } else {
      for (const block of blocksOf(row)) {
        switch (block.type) {
          case "text": {
            const rendered = typeof block.text === "string" ? renderUserText(block.text) : null;
            if (rendered) { blocks.push(rendered); onlyNotes = false; }
            break;
          }
          case "thinking":
            if (typeof block.thinking === "string" && block.thinking.trim()) { blocks.push({ kind: "thinking", text: block.thinking }); onlyNotes = false; }
            break;
          case "tool_use": {
            const name = stringOr(block.name, null);
            const input = isRecord(block.input) ? block.input : {};
            blocks.push({
              kind: "tool",
              name: name ?? "tool",
              summary: summariseToolInput(name ?? "", input),
              ...fileOf(input),
              ...questionsOf(name ?? "", input),
              result: (typeof block.id === "string" && results.get(block.id)) || null,
            });
            onlyNotes = false;
            break;
          }
          case "image": {
            // The bytes stay on disk. A transcript here holds 3.3MB of base64
            // across 28 images, so inlining them would bloat every reader
            // response; the block carries a reference the client fetches. The
            // reference names the row, so a row without an id has no image to
            // offer. Counted either way, as `readSessionImage` counts them.
            const nth = imageIndex++;
            if (typeof row.uuid !== "string") break;
            const source = isRecord(block.source) ? block.source : {};
            blocks.push({ kind: "image", mediaType: stringOr(source.media_type, "image"), ref: `${row.uuid}:${nth}` });
            onlyNotes = false;
            break;
          }
          // A model switch (Fable to Opus, say): chrome worth a quiet note,
          // not silence. Real occurrences (13) carry only `to.model`.
          case "fallback": {
            const to = isRecord(block.to) ? stringOr(block.to.model, "") : "";
            blocks.push({ kind: "text", text: to ? `Switched to ${to}` : "Model switched" });
            break;
          }
          // tool_result was already folded into its tool_use above.
          default:
            break;
        }
      }
    }

    if (blocks.length === 0) continue;

    messages.push({
      id,
      role: onlyNotes && type === "assistant" ? "system" : type === "assistant" ? "agent" : "you",
      at,
      blocks,
    });
  }

  return messages;
}

/** The row's content blocks that are objects; a `null` or a bare string in the list is skipped. */
function blocksOf(row: Record<string, unknown>): RawBlock[] {
  const content = isRecord(row.message) ? row.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/**
 * Renders user-authored text, unwrapping the tagged forms Claude Code uses.
 *
 * A `user` record is only sometimes the human talking, and the tags are how you
 * tell. Scanned across 22 real transcripts, the ones that actually occur are
 * `<task-notification>` (48), `<command-name>`/`<command-args>` (10),
 * `<local-command-stdout>` (5), and `<system-reminder>`. Left alone they render
 * as the user having typed a wall of XML — the same misattribution as showing
 * tool results as "you said", just less obvious because it is rarer.
 *
 * `<bash-input>` and `<bash-stdout>`/`<bash-stderr>` are Claude Code's `!cmd`
 * mode, a row for what was typed and one for what it printed (7 of each in a
 * September 2026 census, rendered as raw XML until that review). Codex user
 * messages carry the same tags, so its reader uses this too.
 *
 * Returns null for anything that is not worth showing as a message.
 */
export function renderUserText(raw: string): LogBlock | null {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return null;

  const inner = (tag: string) =>
    text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

  // A background agent reporting in — machine-generated, not typed by anyone.
  if (text.includes("<task-notification>")) {
    const summary = inner("summary");
    const status = inner("status");
    const result = inner("result");
    const headline = summary ?? "Background task";
    return {
      kind: "text",
      text: [status ? `${headline} (${status})` : headline, result].filter(Boolean).join("\n"),
    };
  }

  const command = inner("command-name");
  if (command) {
    const args = inner("command-args");
    return { kind: "text", text: args ? `${command} ${args}` : command };
  }

  const stdout = inner("local-command-stdout");
  if (stdout !== undefined) return stdout ? { kind: "text", text: stdout } : null;

  // Written the way Claude Code draws it: `! ls`.
  const bash = inner("bash-input");
  if (bash !== undefined) return bash ? { kind: "text", text: `! ${bash}` } : null;

  const printed = [inner("bash-stdout"), inner("bash-stderr")];
  if (printed.some((part) => part !== undefined)) {
    const output = printed.filter(Boolean).join("\n");
    return output ? { kind: "text", text: output } : null;
  }

  return { kind: "text", text };
}

/**
 * Flattens the several shapes `tool_result.content` takes.
 *
 * Images inside a result are the common case — reading a screenshot returns one
 * — and were previously collapsed to the literal text `[image]`. They now carry
 * a ref, the same handle a top-level image block uses.
 */
function flattenResult(
  block: RawBlock,
  uuid: string | null,
  nextImage: () => number,
): { text: string; isError: boolean; truncated: boolean; images: string[] } {
  const images: string[] = [];
  const content = block.content;
  let text: string;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (part.type === "text") return stringOr(part.text, "");
        if (part.type === "image") {
          // Counted even when unservable, as `readSessionImage` counts them.
          const nth = nextImage();
          if (uuid) images.push(`${uuid}:r${nth}`);
          return "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = content == null ? "" : JSON.stringify(content);
  }

  const truncated = text.length > MAX_RESULT_CHARS;
  return {
    text: truncated ? `${text.slice(0, MAX_RESULT_CHARS)}\n…` : text,
    isError: block.is_error === true,
    truncated,
    images,
  };
}

/**
 * One line describing what a tool call did.
 *
 * A collapsed tool row is only useful if it says which file or which command;
 * "Bash" on its own tells a reader nothing.
 */
/**
 * The questions an agent stopped to ask, with their options.
 *
 * `AskUserQuestion` carries the whole exchange in its input, and the reader was
 * throwing it away: what showed was a collapsed row named after the tool, with
 * none of the choices it was asking you to make. Reported from a phone, where
 * that is the entire message.
 */
export function questionsOf(
  name: string,
  input: Record<string, unknown>,
): { questions?: { text: string; options: { label: string; description?: string }[] }[] } {
  if (name !== "AskUserQuestion") return {};

  const asked = Array.isArray(input.questions) ? input.questions : [];
  const questions = asked
    .filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
    .map((q) => ({
      text: typeof q.question === "string" ? q.question : "",
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
        .map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          ...(typeof o.description === "string" && o.description
            ? { description: o.description }
            : {}),
        }))
        .filter((o) => o.label),
    }))
    .filter((q) => q.text && q.options.length > 0);

  return questions.length > 0 ? { questions } : {};
}

/**
 * The file a tool call named, if it named one.
 *
 * Only an absolute path counts. A relative one cannot be resolved without
 * knowing where the agent was standing, and offering to open something the
 * server would then fail to find is worse than offering nothing.
 */
export function fileOf(input: Record<string, unknown>): { file?: { path: string; name: string } } {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value !== "string" || !value.startsWith("/")) continue;
    return { file: { path: value, name: value.slice(value.lastIndexOf("/") + 1) } };
  }
  return {};
}

/** The text of the first question, for the one-line summary. */
function firstQuestion(input: Record<string, unknown>): string | undefined {
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  const text = (first as { question?: unknown } | undefined)?.question;
  return typeof text === "string" ? text : undefined;
}

export function summariseToolInput(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);

  const candidate =
    firstQuestion(input) ??
    str("command") ??
    str("file_path") ??
    str("path") ??
    str("pattern") ??
    str("query") ??
    str("url") ??
    str("prompt") ??
    str("description") ??
    str("skill") ??
    str("subject");

  // Empty rather than the tool's own name: the client draws the name already,
  // so falling back to it rendered "SendUserFile SendUserFile".
  if (!candidate) return "";

  const oneLine = candidate.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}


/**
 * The only types an image out of a transcript is ever served as.
 *
 * `media_type` is a string in a file the agent writes, and the agent writes
 * what it was given — a tool result from an MCP server, a fetched page. Served
 * verbatim it made `/api/panes/:id/image` an arbitrary-bytes,
 * arbitrary-content-type responder on the app's own origin: `text/html` there
 * is a page with this origin's cookie, and `nosniff` does nothing against a
 * type the server *declared*. So the same rule as `/api/file`: a short list,
 * and anything else is an opaque download. SVG is deliberately absent — it
 * runs script.
 */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imageMediaType(declared: unknown): string {
  return typeof declared === "string" && IMAGE_TYPES.has(declared) ? declared : "application/octet-stream";
}

/**
 * Recovers an image's bytes from a transcript.
 *
 * `ref` is `<record uuid>:<nth image in that record>`, which survives the
 * message being re-read and re-paginated — unlike a position in the rendered
 * list, which shifts as the transcript grows.
 */
export async function readSessionImage(
  sessionId: string,
  ref: string,
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const separator = ref.lastIndexOf(":");
  if (separator <= 0) return null;
  const uuid = ref.slice(0, separator);
  const wanted = Number(ref.slice(separator + 1));

  const path = await findTranscript(sessionId);
  if (!path) return null;

  // `r` marks an image that came back inside a tool result rather than as a
  // block of the message itself.
  const inResult = ref.slice(separator + 1).startsWith("r");
  const index = inResult ? Number(ref.slice(separator + 2)) : wanted;

  // Streamed and stopped at the match rather than parsed whole. One transcript
  // here is 38MB and holds 3.3MB of base64 across 28 images; reading all of it
  // into memory to answer for one of them is what this endpoint used to do.
  let found: { bytes: Uint8Array; mediaType: string } | null = null;

  await scanLines(path, 0, (_offset, row) => {
    if (found || row.uuid !== uuid) return;
    let seen = 0;
    for (const block of blocksOf(row)) {
      const parts = inResult
        ? block.type === "tool_result" && Array.isArray(block.content)
          ? block.content.filter((p): p is RawBlock => isRecord(p) && p.type === "image")
          : []
        : block.type === "image"
          ? [block]
          : [];

      for (const part of parts) {
        if (seen++ !== index) continue;
        const source = isRecord(part.source) ? part.source : {};
        if (typeof source.data !== "string" || !source.data) return;
        found = {
          bytes: Uint8Array.from(atob(source.data), (c) => c.charCodeAt(0)),
          mediaType: imageMediaType(source.media_type),
        };
        return;
      }
    }
  });

  return found;
}
