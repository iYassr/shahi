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
 * between polls, and only those bytes are read. A file that shrank was replaced
 * rather than appended to, so that one starts over.
 */
interface TranscriptIndex {
  /** Bytes indexed so far — always the end of the last complete line. */
  size: number;
  /** Byte offset of the line that produced each message, in order. */
  offsets: number[];
}

/** Indexes are small; this bound is a backstop, not a working constraint. */
const MAX_INDEXES = 64;

const indexes = new Map<string, TranscriptIndex>();

/**
 * Reads whole lines from `from`, returning the offset after the last complete
 * one.
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
): Promise<number> {
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
          onRow(consumed + start, JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A partially-written line, or one this version cannot read. Skipping
          // it costs one message; failing the read costs the whole transcript.
        }
      }
      start = i + 1;
    }
    consumed += start;
    pending = buffer.subarray(start);
  }
  return consumed;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Builds the index, or extends the one already held, up to the file's end. */
export async function indexTranscript(path: string): Promise<TranscriptIndex> {
  const size = Bun.file(path).size;
  const held = indexes.get(path);

  // Only ever appended to in normal use; anything else means a different file
  // wearing the same name.
  const index: TranscriptIndex =
    held && size >= held.size ? held : { size: 0, offsets: [] };

  if (index.size !== size) {
    index.size = await scanLines(path, index.size, (offset, row) => {
      if (normalise([row]).length > 0) index.offsets.push(offset);
    });
  }

  indexes.delete(path);
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
 * The preview alone, cheaply enough for a dashboard that refreshes every few
 * seconds: the index already caches by file size, so an unchanged transcript
 * costs one stat, and a grown one costs a tail read of a few messages.
 */
export async function previewFor(sessionId: string): Promise<string | null> {
  const log = await readSessionLog(sessionId, { limit: 3 });
  return log ? previewOf(log.messages) : null;
}

/**
 * Messages beyond the window, read so the last tool call in it can still find
 * its result. Its `tool_result` is in a later row, and without a few rows of
 * slack the newest call in a page would render without its output.
 */
const PAIRING_SLACK = 4;

/** Reads and normalises a window of a transcript, newest messages last. */
export async function readSessionLog(
  sessionId: string,
  options: { limit?: number; before?: number } = {},
): Promise<SessionLog | null> {
  const path = await findTranscript(sessionId);
  if (!path) return null;
  const log = await readWindow(path, options);
  return log && { ...log, sessionId };
}

/** The same, by path — which is what the tests can reach. */
export async function readWindow(
  path: string,
  options: { limit?: number; before?: number } = {},
): Promise<SessionLog | null> {
  const index = await indexTranscript(path);
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
  const messages = normalise(parseLines(window)).slice(0, end - start);

  return { sessionId: path, path, messages, total, offset: index.size };
}

export function parseLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A partially-written final line is normal while tailing a live session.
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { media_type?: string; data?: string };
}

/**
 * Turns raw records into renderable messages.
 *
 * The important move is pairing: a `tool_use` in an assistant record and its
 * `tool_result` in the following user record are one event to a reader, so they
 * are merged into a single block. Doing otherwise produces a transcript that
 * alternates between the agent calling a tool and the "user" replying with its
 * output, which is both wrong and unreadable.
 */
export function normalise(rows: Record<string, unknown>[]): LogMessage[] {
  // First pass: collect every tool result so a call can carry its own output.
  const results = new Map<
    string,
    { text: string; isError: boolean; truncated: boolean; images: string[] }
  >();
  for (const row of rows) {
    let resultImage = 0;
    for (const block of blocksOf(row)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, flattenResult(block, row.uuid as string, () => resultImage++));
      }
    }
  }

  const messages: LogMessage[] = [];

  for (const [index, row] of rows.entries()) {
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;

    // Slash-command expansions are written for the model, not the reader.
    if (row.isMeta === true) continue;

    const blocks: LogBlock[] = [];
    let imageIndex = 0;
    const content = (row.message as { content?: unknown } | undefined)?.content;

    if (typeof content === "string") {
      const rendered = renderUserText(content);
      if (rendered) blocks.push(rendered);
    } else {
      for (const block of blocksOf(row)) {
        switch (block.type) {
          case "text": {
            const rendered = renderUserText(block.text ?? "");
            if (rendered) blocks.push(rendered);
            break;
          }
          case "thinking":
            if (block.thinking?.trim()) blocks.push({ kind: "thinking", text: block.thinking });
            break;
          case "tool_use":
            blocks.push({
              kind: "tool",
              name: block.name ?? "tool",
              summary: summariseToolInput(block.name ?? "", block.input ?? {}),
              ...fileOf(block.input ?? {}),
              ...questionsOf(block.name ?? "", block.input ?? {}),
              result: (block.id && results.get(block.id)) || null,
            });
            break;
          case "image":
            // The bytes stay on disk. A transcript here holds 3.3MB of base64
            // across 28 images, so inlining them would bloat every reader
            // response; the block carries a reference the client fetches.
            blocks.push({
              kind: "image",
              mediaType: block.source?.media_type ?? "image",
              ref: `${row.uuid as string}:${imageIndex++}`,
            });
            break;
          // tool_result was already folded into its tool_use above.
          default:
            break;
        }
      }
    }

    if (blocks.length === 0) continue;

    messages.push({
      id: (row.uuid as string) ?? `row-${index}`,
      role: type === "assistant" ? "agent" : "you",
      at: Date.parse((row.timestamp as string) ?? "") || 0,
      blocks,
    });
  }

  return messages;
}

function blocksOf(row: Record<string, unknown>): RawBlock[] {
  const content = (row.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as RawBlock[]) : [];
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
 * Returns null for anything that is not worth showing as a message.
 */
function renderUserText(raw: string): LogBlock | null {
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
  uuid: string,
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
        const p = part as RawBlock;
        if (p.type === "text") return p.text ?? "";
        if (p.type === "image") {
          images.push(`${uuid}:r${nextImage()}`);
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
          ? (block.content as RawBlock[]).filter((p) => p.type === "image")
          : []
        : block.type === "image"
          ? [block]
          : [];

      for (const part of parts) {
        if (seen++ !== index) continue;
        const data = part.source?.data;
        if (!data) return;
        found = {
          bytes: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
          mediaType: part.source?.media_type ?? "application/octet-stream",
        };
        return;
      }
    }
  });

  return found;
}
