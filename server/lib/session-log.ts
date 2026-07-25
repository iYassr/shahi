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
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Tool output can be enormous; the phone gets a readable slice. */
const MAX_RESULT_CHARS = 2_000;

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "image"; mediaType: string }
  | {
      kind: "tool";
      name: string;
      /** One-line summary of the call, e.g. the command or the file path. */
      summary: string;
      result: { text: string; isError: boolean; truncated: boolean } | null;
    };

export interface LogMessage {
  id: string;
  /** `agent` and `you` are the two that render as conversation. */
  role: "you" | "agent" | "system";
  at: number;
  blocks: Block[];
}

export interface SessionLog {
  sessionId: string;
  path: string;
  messages: LogMessage[];
  /** Total messages available, so the client knows more history exists. */
  total: number;
  /** Byte offset consumed, for tailing. */
  offset: number;
}

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
 * Cache keyed on file size.
 *
 * A full read of the largest transcript here (4.9MB, 516 messages) measured at
 * 27-35ms, which is cheap enough to re-read rather than maintain an incremental
 * parser — and re-reading keeps tool_use/tool_result pairing correct, which
 * incremental parsing would break whenever a call and its result straddled the
 * boundary. Size is a sufficient key because the file is only ever appended to.
 */
const cache = new Map<string, { size: number; messages: LogMessage[] }>();

/** Reads and normalises a transcript, newest messages last. */
export async function readSessionLog(
  sessionId: string,
  options: { limit?: number; before?: number } = {},
): Promise<SessionLog | null> {
  const path = await findTranscript(sessionId);
  if (!path) return null;

  const file = Bun.file(path);
  const size = file.size;

  const cached = cache.get(path);
  let all: LogMessage[];
  if (cached && cached.size === size) {
    all = cached.messages;
  } else {
    all = normalise(parseLines(await file.text()));
    cache.set(path, { size, messages: all });
  }

  const limit = options.limit ?? 200;
  const end = options.before ?? all.length;
  const start = Math.max(0, end - limit);

  return {
    sessionId,
    path,
    messages: all.slice(start, end),
    total: all.length,
    offset: size,
  };
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
  source?: { media_type?: string };
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
  const results = new Map<string, { text: string; isError: boolean; truncated: boolean }>();
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, flattenResult(block));
      }
    }
  }

  const messages: LogMessage[] = [];

  for (const [index, row] of rows.entries()) {
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;

    // Slash-command expansions are written for the model, not the reader.
    if (row.isMeta === true) continue;

    const blocks: Block[] = [];
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
              result: (block.id && results.get(block.id)) || null,
            });
            break;
          case "image":
            blocks.push({ kind: "image", mediaType: block.source?.media_type ?? "image" });
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
function renderUserText(raw: string): Block | null {
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

/** Flattens the several shapes `tool_result.content` takes. */
function flattenResult(block: RawBlock): { text: string; isError: boolean; truncated: boolean } {
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
        if (p.type === "image") return "[image]";
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
  };
}

/**
 * One line describing what a tool call did.
 *
 * A collapsed tool row is only useful if it says which file or which command;
 * "Bash" on its own tells a reader nothing.
 */
export function summariseToolInput(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);

  const candidate =
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

  if (!candidate) return name;

  const oneLine = candidate.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}
