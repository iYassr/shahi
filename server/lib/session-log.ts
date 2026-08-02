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
 * Cache keyed on file size, bounded by the bytes it came from.
 *
 * A full read is cheap enough to prefer over an incremental parser — and
 * re-reading keeps tool_use/tool_result pairing correct, which incremental
 * parsing would break whenever a call and its result straddled the boundary.
 * Size is a sufficient key because the file is only ever appended to.
 *
 * The bound is the part that was missing, and it cost 443MB of resident memory
 * before anyone looked. This was written when the largest transcript here was
 * 4.9MB and 516 messages; a year of use later the same directory holds 489MB
 * across it, with single files at 38 and 50MB and one pane reporting 2,310
 * messages. Measured on the live server: opening one pane took the process from
 * 76MB to 282MB, six panes took it to 443MB, and none of it ever came back,
 * because an unbounded Map keyed on path holds every transcript ever opened.
 * Parsed objects run about five times the file they came from.
 *
 * Polling the same pane is not the problem — ten repeat polls cost 1.4MB, since
 * the size key hits. Only distinct panes accumulate. So the fix is eviction, not
 * a different cache: least-recently-used, budgeted in source bytes, and always
 * keeping the newest entry however large it is — dropping that one would mean
 * re-parsing 38MB on every poll of the pane you are actually reading.
 */
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024;

const cache = new Map<string, { size: number; messages: LogMessage[] }>();

/**
 * Records a parsed transcript as the most recently used, then evicts from the
 * far end until the held bytes fit the budget.
 *
 * `Map` iterates in insertion order, so re-inserting on every hit is what makes
 * that order least-recently-used.
 */
export function remember(
  path: string,
  entry: { size: number; messages: LogMessage[] },
  budget = CACHE_BUDGET_BYTES,
  store = cache,
): void {
  store.delete(path);
  store.set(path, entry);

  let held = 0;
  let kept = 0;
  for (const [key, held_entry] of [...store].reverse()) {
    held += held_entry.size;
    kept += 1;
    /*
     * Two are kept whatever they cost, and only then does the budget apply.
     *
     * One is not enough: a single transcript here is 38MB, so a budget in
     * source bytes holds about one of them, and moving between two panes would
     * evict each on the way to the other — a 200ms re-parse every 2.5 seconds,
     * for as long as you had them both open. Holding the second is much cheaper
     * than re-reading it forever, and past two the budget is the right call.
     */
    if (kept > 2 && held > budget) store.delete(key);
  }
}

/** Test seam: what the cache is holding, newest last. */
export function cachedPaths(store = cache): string[] {
  return [...store.keys()];
}

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
    // Re-inserted even on a hit, or the pane you keep coming back to ages out
    // behind ones you opened once.
    remember(path, cached);
  } else {
    all = normalise(parseLines(await file.text()));
    remember(path, { size, messages: all });
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

  for (const row of parseLines(await Bun.file(path).text())) {
    if (row.uuid !== uuid) continue;
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
        if (!data) return null;
        return {
          bytes: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
          mediaType: part.source?.media_type ?? "application/octet-stream",
        };
      }
    }
  }
  return null;
}
