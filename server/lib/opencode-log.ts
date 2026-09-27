/** OpenCode's v1 message projection, also consumed by its own TUI/API.
 * Measured against 1.18.32 (545f51d). The database is shared by all sessions:
 * an open DB or a working directory is never evidence of pane ownership.
 * Only herdr's integration-reported session id selects a conversation. */
import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogBlock, LogMessage, SessionLog } from "@shahi/shared";
import { imageMediaType, isRecord, questionsOf, summariseToolInput } from "./session-log";

export interface OpenCodeTranscript { kind: "opencode"; databasePath: string; sessionId: string }
const SESSION = /^ses_[A-Za-z0-9_-]{1,128}$/;
const ID = /^(?:msg|prt)_[A-Za-z0-9_-]{1,128}$/;
const MAX_TEXT = 65_536;
const MAX_RESULT = 8_192;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_READ = 2 * 1024 * 1024;
const TRUNCATED = "\n… [Reader excerpt]";
const REMOVAL_EVENTS = ["message.removed.1", "message.part.removed.1", "session.next.revert.committed.1"];
const ERROR_NAMES = ["APIError", "ProviderAuthError", "MessageAbortedError", "UnknownError", "MessageOutputLengthError", "StructuredOutputError", "ContextOverflowError", "ContentFilterError"];

export function defaultOpenCodeDatabase(): string {
  const root = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
  const custom = process.env.OPENCODE_DB;
  return custom ? (custom === ":memory:" || isAbsolute(custom) ? custom : join(root, custom)) : join(root, "opencode.db");
}

function open(source: OpenCodeTranscript): Database {
  const db = new Database(source.databasePath, { readonly: true, strict: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 100");
  return db;
}

export async function findOpenCodeTranscript(sessionId: string, databasePath = defaultOpenCodeDatabase()): Promise<OpenCodeTranscript | null> {
  if (!SESSION.test(sessionId) || databasePath === ":memory:") return null;
  let db: Database | undefined;
  try {
    if (!(await stat(databasePath)).isFile()) return null;
    const source: OpenCodeTranscript = { kind: "opencode", databasePath, sessionId };
    db = open(source);
    return db.query("SELECT id FROM session WHERE id = ?").get(sessionId) ? source : null;
  } catch { return null; }
  finally { db?.close(); }
}

/** WAL writes and same-size rewrites both invalidate pages. No checkpoint or
 * migration is ever run against the provider's database. */
export async function openCodeStamp(source: OpenCodeTranscript): Promise<{ version: string; mtimeMs: number }> {
  const file = await stat(source.databasePath);
  const wal = await stat(`${source.databasePath}-wal`).catch(() => null);
  const stamp = (s: typeof file | null) => s ? `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "absent";
  return { version: `${source.sessionId}:${stamp(file)}:${stamp(wal)}`, mtimeMs: Math.max(file.mtimeMs, wal?.mtimeMs ?? 0) };
}

// SQLite's text substr ends at NUL. Treat binary-shaped string fields as
// unsupported in both visibility and rendering instead of counting a row
// whose bounded projection would disappear.
const str = (x: unknown): string => typeof x === "string" && !x.includes("\0") ? x : "";
const obj = (x: unknown): Record<string, unknown> => isRecord(x) ? x : {};
const time = (x: unknown): number => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
function excerpt(value: unknown, max = MAX_TEXT): string {
  const text = str(value);
  if (text.length <= max) return text;
  let end = max;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end) + TRUNCATED;
}
function parse(value: unknown): Record<string, unknown> {
  try { return obj(JSON.parse(str(value))); } catch { return {}; }
}
function filePath(part: Record<string, unknown>): string | null {
  const source = obj(part.source);
  if ((source.type === "file" || source.type === "symbol") && str(source.path).length <= 4096 && isAbsolute(str(source.path))) return str(source.path);
  try {
    const url = new URL(str(part.url));
    if (url.protocol === "file:" && (!url.hostname || url.hostname === "localhost") && url.href.length <= 4096) {
      const path = fileURLToPath(url);
      return path.includes("\0") ? null : path;
    }
  } catch { /* A data URI has no local file to open. */ }
  return null;
}
function fileBlock(path: string, name = "File"): LogBlock {
  return { kind: "tool", name, summary: excerpt(path, 120), file: { path, name: excerpt(basename(path), 256) }, result: { text: "", isError: false, truncated: false, images: [] } };
}
function imageRef(session: string, part: string, attachment?: number): string {
  return `${session}:${part}:${attachment === undefined ? "file" : `a${attachment}`}`;
}
function attachment(part: Record<string, unknown>, ref: string): LogBlock | null {
  const mime = str(part.mime);
  if (!mime) return null; // Required by OpenCode's FilePart, even for local files.
  const local = filePath(part);
  if (local) return fileBlock(local, "Attachment");
  if (imageMediaType(mime) !== "application/octet-stream" && str(part.url).startsWith(`data:${mime};base64,`)) {
    return { kind: "image", mediaType: mime, ref };
  }
  const name = excerpt(str(part.filename) || mime, 256);
  return name ? { kind: "text", text: `Attachment: ${name}${mime && name !== mime ? ` (${mime})` : ""}` } : null;
}
function errorText(error: unknown): string {
  const value = obj(error);
  if (!ERROR_NAMES.includes(str(value.name))) return "";
  const text = str(obj(value.data).message);
  if (text) return excerpt(text);
  return value.name === "MessageOutputLengthError" ? "The response reached the model's output limit." : "";
}
function boundedQuestions(name: string, input: Record<string, unknown>) {
  const { questions } = questionsOf(name, input);
  return questions ? { questions: questions.slice(0, 8).map(q => ({ text: excerpt(q.text, 1024), options: q.options.slice(0, 16).map(o => ({ label: excerpt(o.label, 128), ...(o.description ? { description: excerpt(o.description, 256) } : {}) })) })) } : {};
}
function boundedBlocks(blocks: LogBlock[]): LogBlock[] {
  let bytes = 0;
  const kept: LogBlock[] = [];
  for (const block of blocks) {
    const size = Buffer.byteLength(JSON.stringify(block));
    if (bytes + size > 384 * 1024) {
      kept.push({ kind: "text", text: "Additional message content exceeds the Reader limit; view it in OpenCode." });
      break;
    }
    kept.push(block); bytes += size;
  }
  return kept;
}

/** Accepts the documented {info,parts} API shape as well as our SQLite projection.
 * Unknown parts, synthetic context and provider metadata never become prose. */
export function normaliseOpenCode(rows: unknown[], sessionId: string): LogMessage[] {
  if (!SESSION.test(sessionId)) return [];
  return rows.flatMap(raw => {
    const row = obj(raw), info = obj(row.info);
    if (info.sessionID !== sessionId || !ID.test(str(info.id)) || !["user", "assistant"].includes(str(info.role))) return [];
    const blocks: LogBlock[] = [];
    let substantive = false;
    for (const value of Array.isArray(row.parts) ? row.parts : []) {
      const part = obj(value);
      if (part.sessionID !== sessionId || part.messageID !== info.id || !ID.test(str(part.id))) continue;
      switch (part.type) {
        case "text":
          if ((part.synthetic == null || part.synthetic === false) && (part.ignored == null || part.ignored === false) && str(part.text).trim()) { blocks.push({ kind: "text", text: excerpt(part.text) }); substantive = true; }
          break;
        case "reasoning":
          if (info.role === "assistant" && str(part.text).trim()) { blocks.push({ kind: "thinking", text: excerpt(part.text) }); substantive = true; }
          break;
        case "file": {
          const block = attachment(part, imageRef(sessionId, str(part.id)));
          if (block) { blocks.push(block); substantive = true; }
          break;
        }
        case "agent":
          if (str(part.name)) { blocks.push({ kind: "text", text: `@${excerpt(part.name, 200)}` }); substantive = true; }
          break;
        case "tool": {
          const state = obj(part.state), input = obj(state.input), metadata = obj(state.metadata);
          if (!str(part.tool) || !["pending", "running", "completed", "error"].includes(str(state.status))) break;
          const mapped = { ...input, file_path: input.filePath ?? input.file_path };
          const path = str(mapped.file_path) || str(input.path);
          const done = state.status === "completed" || state.status === "error";
          const compacted = time(obj(state.time).compacted) > 0;
          const images: string[] = [], labels: string[] = [];
          const attachments = Array.isArray(state.attachments) ? state.attachments : [];
          if (!compacted) attachments.slice(0, 32).forEach((a, index) => {
            const block = attachment(obj(a), imageRef(sessionId, str(part.id), index));
            if (block?.kind === "image") images.push(block.ref);
            else if (block?.kind === "text") labels.push(block.text);
            else if (block) blocks.push(block);
          });
          const output = compacted ? "Earlier tool output was compacted by OpenCode." : [
            state.status === "error" ? str(state.error) : str(state.output),
            state.status === "error" && metadata.interrupted === true ? str(metadata.output) : "",
            state.status === "completed" && typeof metadata.diff === "string" ? metadata.diff : "",
            state.status === "completed" && part.tool === "write" ? excerpt(input.content, MAX_RESULT) : "",
            ...labels,
          ].filter(Boolean).join("\n\n");
          const text = excerpt(output, MAX_RESULT);
          blocks.push({
            kind: "tool", name: excerpt(part.tool, 200), summary: summariseToolInput(str(part.tool), mapped) || excerpt(state.title, 120),
            ...(path && path.length <= 4096 && isAbsolute(path) ? { file: { path, name: excerpt(basename(path), 256) } } : {}),
            ...boundedQuestions(part.tool === "question" ? "AskUserQuestion" : str(part.tool), input),
            ...(compacted ? { outputUnavailable: true } : {}),
            result: done ? { text, isError: state.status === "error", truncated: text !== output || part.readerTruncated === true, images } : null,
          });
          substantive = true;
          break;
        }
        case "compaction":
          blocks.push({ kind: "text", text: part.auto ? "Conversation compacted automatically." : "Conversation compacted." });
          break;
        case "subtask":
          if (str(part.prompt)) blocks.push({ kind: "text", text: [str(part.description), str(part.agent) ? `Agent: ${str(part.agent)}` : "", excerpt(part.prompt)].filter(Boolean).join("\n\n") });
          break;
        case "retry": {
          const error = errorText(part.error);
          if (error) blocks.push({ kind: "text", text: `Retry${time(part.attempt) ? ` ${time(part.attempt)}` : ""}: ${error}` });
          break;
        }
        // Step boundaries, token usage, snapshots and patch hashes are chrome.
        default: break;
      }
    }
    const error = errorText(info.error);
    if (error) blocks.push({ kind: "text", text: error });
    if (!blocks.length) return [];
    return [{ id: `${sessionId}:${str(info.id)}`, role: !substantive || info.summary === true ? "system" : info.role === "user" ? "you" : "agent", at: time(obj(info.time).created), blocks: boundedBlocks(blocks) }];
  });
}

// The existing API 5 clients page by total minus returned *messages*. Counting
// raw database rows stranded them behind a tail of synthetic-only messages.
// These predicates are the same allowlist as the normalizer, applied before
// COUNT/LIMIT. Correlation uses OpenCode's part_message_id_id_idx index; only
// the requested visible window is hydrated into JavaScript.
const SQL_SPACE = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
function sqlString(data: string, field: string, trim = false): string {
  const value = `json_extract(${data},'${field}')`;
  return `(json_type(${data},'${field}')='text' AND instr(${value},char(0))=0 AND ${trim ? `trim(${value},${SQL_SPACE})` : value}<>'')`;
}
function sqlError(data: string): string {
  return `(json_extract(${data},'$.error.name') IN (${ERROR_NAMES.map(x => `'${x}'`).join(",")}) AND
    (${sqlString(data, "$.error.data.message")} OR json_extract(${data},'$.error.name')='MessageOutputLengthError'))`;
}
function sqlId(id: string): string {
  return `(length(${id}) BETWEEN 5 AND 132 AND instr(${id},char(0))=0 AND (${id} GLOB 'msg_*' OR ${id} GLOB 'prt_*') AND ${id} NOT GLOB '*[^A-Za-z0-9_-]*')`;
}
function sqlVisiblePart(alias: string, role: string): string {
  const d = `${alias}.data`, kind = `json_extract(${d},'$.type')`;
  return `${sqlId(`${alias}.id`)} AND CASE WHEN json_valid(${d}) THEN (
    (${kind}='text' AND ${sqlString(d, "$.text", true)}
      AND coalesce(json_type(${d},'$.synthetic'),'null') IN ('false','null')
      AND coalesce(json_type(${d},'$.ignored'),'null') IN ('false','null'))
    OR (${kind}='reasoning' AND ${role}='assistant' AND ${sqlString(d, "$.text", true)})
    OR (${kind}='tool' AND ${sqlString(d, "$.tool")} AND json_extract(${d},'$.state.status') IN ('pending','running','completed','error'))
    OR (${kind}='file' AND ${sqlString(d, "$.mime")})
    OR (${kind}='agent' AND ${sqlString(d, "$.name")})
    OR (${kind}='subtask' AND ${sqlString(d, "$.prompt")})
    OR ${kind}='compaction'
    OR (${kind}='retry' AND ${sqlError(d)})
  ) ELSE 0 END`;
}
const VISIBLE_MESSAGE = `${sqlId("m.id")} AND CASE WHEN json_valid(m.data) THEN
  json_extract(m.data,'$.role') IN ('user','assistant') AND (
    ${sqlError("m.data")} OR EXISTS (SELECT 1 FROM part p WHERE p.message_id=m.id AND p.session_id=m.session_id
      AND ${sqlVisiblePart("p", "json_extract(m.data,'$.role')")})
  ) ELSE 0 END`;
function projectedError(data: string): string {
  return `json_object('name',json_extract(${data},'$.error.name'),'data',json_object('message',
    CASE WHEN json_type(${data},'$.error.data.message')='text' THEN substr(json_extract(${data},'$.error.data.message'),1,65537) END))`;
}

/** Project before crossing SQLite -> JS so a 20 MB inline image or enormous
 * tool output never enters the Reader page. Image bytes have their own route.
 * json_valid guards a damaged row without losing the rest of the session. */
const PART_SELECT = `SELECT id,
  json_extract(data,'$.type') AS type,
  CASE WHEN json_type(data,'$.text')='text' THEN substr(json_extract(data,'$.text'),1,65537)
    || CASE WHEN length(json_extract(data,'$.text'))>65537 THEN '… [Reader excerpt]' ELSE '' END END AS text,
  json_extract(data,'$.synthetic') AS synthetic, json_extract(data,'$.ignored') AS ignored,
  substr(json_extract(data,'$.mime'),1,200) AS mime, substr(json_extract(data,'$.filename'),1,4096) AS filename,
  CASE WHEN json_type(data,'$.url')='text' AND instr(json_extract(data,'$.url'),char(0))=0 THEN substr(json_extract(data,'$.url'),1,4097) END AS url,
  CASE WHEN length(json_extract(data,'$.source')) <= 8192 THEN json_extract(data,'$.source') END AS source,
  substr(json_extract(data,'$.name'),1,200) AS name, substr(json_extract(data,'$.tool'),1,200) AS tool,
  json_extract(data,'$.state.status') AS status,
  CASE WHEN length(json_extract(data,'$.state.input')) <= 65536 THEN json_extract(data,'$.state.input') END AS input,
  substr(json_extract(data,'$.state.output'),1,8193) AS output, substr(json_extract(data,'$.state.error'),1,8193) AS tool_error,
  substr(json_extract(data,'$.state.title'),1,200) AS title,
  CASE WHEN length(json_extract(data,'$.state.metadata')) <= 65536 THEN json_extract(data,'$.state.metadata') END AS metadata,
  json_extract(data,'$.state.time.compacted') AS compacted,
  json_extract(data,'$.auto') AS auto, substr(json_extract(data,'$.prompt'),1,65537) AS prompt,
  substr(json_extract(data,'$.description'),1,4096) AS description, substr(json_extract(data,'$.agent'),1,200) AS agent,
  json_extract(data,'$.attempt') AS attempt,
  ${projectedError("data")} AS error
  FROM part WHERE session_id = ? AND message_id = ? AND ${sqlVisiblePart("part", "?")} ORDER BY id LIMIT 513`;

function hydratePart(raw: Record<string, unknown>, sessionID: string, messageID: string): Record<string, unknown> {
  return { ...raw, sessionID, messageID, synthetic: raw.synthetic === 1, ignored: raw.ignored === 1, source: parse(raw.source), error: parse(raw.error), state: {
    status: raw.status, input: parse(raw.input), output: raw.output, error: raw.tool_error, title: raw.title,
    metadata: parse(raw.metadata), time: { compacted: raw.compacted },
  } };
}

export async function readOpenCodeLog(source: OpenCodeTranscript, options: { limit?: number; before?: number } = {}): Promise<SessionLog | null> {
  if (!SESSION.test(source.sessionId)) return null;
  let db: Database | undefined;
  try {
    db = open(source);
    return db.transaction(() => {
      const session = db!.query<{ revert: string | null }, [string]>("SELECT revert FROM session WHERE id = ?").get(source.sessionId);
      if (!session) return null;
      // Undo followed by a new prompt prunes old messages and clears `revert`
      // before a phone may poll. The durable removal sequence identifies that
      // branch even across a sidecar restart. Unlike count/mtime/latest ID it
      // stays unchanged while normal replies stream and messages append.
      // Current OpenCode stores these typed v1 events; an unknown older schema
      // fails closed rather than silently merging removed history on a phone.
      const revision = Math.max(0, ...REMOVAL_EVENTS.map(type =>
        (db!.query("SELECT max(seq) AS seq FROM event WHERE aggregate_id=? AND type=?").get(source.sessionId, type) as { seq: number | null }).seq ?? 0));
      // The TUI hides the reverted turn and everything after it. The same
      // boundary prevents an undone instruction reading as current work.
      const reverted = str(parse(session.revert).messageID);
      const boundary = reverted ? db!.query<{ time_created: number; id: string }, [string, string]>("SELECT time_created,id FROM message WHERE session_id=? AND id=?").get(source.sessionId, reverted) : null;
      const where = `m.session_id = ?${boundary ? " AND (m.time_created < ? OR (m.time_created = ? AND m.id < ?))" : ""} AND ${VISIBLE_MESSAGE}`;
      const params = boundary ? [source.sessionId, boundary.time_created, boundary.time_created, boundary.id] : [source.sessionId];
      const total = (db!.query(`SELECT count(*) AS n FROM message m WHERE ${where}`).get(...params) as { n: number }).n;
      const end = Number.isSafeInteger(options.before) ? Math.max(0, Math.min(total, options.before!)) : total;
      const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(200, options.limit!)) : 60;
      const rows = db!.query(`SELECT m.id,json_extract(m.data,'$.role') AS role,
        json_extract(m.data,'$.time.created') AS created,json_extract(m.data,'$.summary') AS summary,
        ${projectedError("m.data")} AS error FROM message m WHERE ${where}
        ORDER BY m.time_created DESC,m.id DESC LIMIT ? OFFSET ?`).all(...params, Math.min(limit, end), total - end) as { id: string; role: string; created: unknown; summary: unknown; error: string }[];
      const messages: LogMessage[] = [];
      let consumed = 0, bytes = 0;
      for (const row of rows) {
        if (bytes >= MAX_PAGE_READ && consumed) break;
        consumed++;
        const info = { role: row.role, time: { created: row.created }, summary: row.summary === 1, error: parse(row.error), id: row.id, sessionID: source.sessionId };
        const parts: Record<string, unknown>[] = [];
        let partBytes = 0;
        for (const raw of db!.query(PART_SELECT).iterate(source.sessionId, row.id, row.role)) {
          const part = hydratePart(raw as Record<string, unknown>, source.sessionId, row.id);
          if (part.type === "tool" && obj(part.state).status === "completed" && !time(obj(obj(part.state).time).compacted)) {
            // Preserve array positions even for malformed members: the image
            // handle names OpenCode's original slot, not a filtered-array index.
            const attachments = db!.query(`SELECT
              CASE WHEN json_each.type='object' THEN substr(json_extract(value,'$.mime'),1,200) END AS mime,
              CASE WHEN json_each.type='object' THEN substr(json_extract(value,'$.filename'),1,4096) END AS filename,
              CASE WHEN json_each.type='object' AND json_type(value,'$.url')='text' AND instr(json_extract(value,'$.url'),char(0))=0 THEN substr(json_extract(value,'$.url'),1,4097) END AS url
              FROM part,json_each(part.data,'$.state.attachments') WHERE part.id=? AND part.session_id=?
              AND json_valid(part.data) AND json_type(part.data,'$.state.attachments')='array'
              ORDER BY CAST(json_each.key AS INTEGER) LIMIT 32`).all(part.id as string, source.sessionId);
            obj(part.state).attachments = attachments;
          }
          const size = Buffer.byteLength(JSON.stringify(part));
          if (partBytes + size > 512 * 1024 || parts.length >= 512) {
            parts.push({ id: "prt_readerlimit", sessionID: source.sessionId, messageID: row.id, type: "text", text: "Additional message content exceeds the Reader limit; view it in OpenCode." });
            break;
          }
          parts.push(part); partBytes += size;
        }
        bytes += partBytes;
        const rendered = normaliseOpenCode([{ info, parts }], source.sessionId);
        // COUNT established a known visible message. An unexpected bounded
        // projection must not create an empty page that API 5 callers repeat
        // forever; admit the omission as a system note, never as user prose.
        messages.unshift(...(rendered.length ? rendered : [{ id: `${source.sessionId}:${row.id}`, role: "system" as const, at: time(row.created), blocks: [{ kind: "text" as const, text: "Message content could not be displayed in Reader. View it in OpenCode." }] }]));
      }
      // API 5 clients reset their loaded history on path changes. A reverted
      // tail has the same message IDs, so only returning fewer rows would leave
      // the undone messages merged into the phone forever. Redo resets too.
      return { sessionId: source.sessionId, path: `${source.databasePath}#${source.sessionId}:revision:${revision}${boundary ? `:revert:${boundary.id}` : ""}`, messages, total, offset: end - consumed };
    })();
  } catch { return null; }
  finally { db?.close(); }
}

/** Exact session + part lookup. No remote URL fetch, arbitrary file read or
 * MIME supplied by an agent is ever turned into active same-origin content. */
export async function readOpenCodeImage(source: OpenCodeTranscript, ref: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const match = /^(ses_[A-Za-z0-9_-]{1,128}):(prt_[A-Za-z0-9_-]{1,128}):(file|a\d{1,2})$/.exec(ref);
  if (!match || match[1] !== source.sessionId) return null;
  let db: Database | undefined;
  try {
    db = open(source);
    const jsonPath = match[3] === "file" ? "$" : `$.state.attachments[${Number(match[3]!.slice(1))}]`;
    const prefix = `${jsonPath}.url`, mimePath = `${jsonPath}.mime`;
    const row = db.query<{ url: string; mime: string }, [string, string, string, string, string, number]>(`SELECT json_extract(data,?) AS url,json_extract(data,?) AS mime FROM part WHERE id=? AND session_id=? AND json_valid(data) AND length(json_extract(data,?)) <= ?`).get(prefix, mimePath, match[2]!, source.sessionId, prefix, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 256);
    if (!row || imageMediaType(row.mime) === "application/octet-stream") return null;
    const header = `data:${row.mime};base64,`;
    if (!row.url.startsWith(header)) return null;
    const data = row.url.slice(header.length);
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, "base64");
    return bytes.length && bytes.length <= MAX_IMAGE_BYTES ? { bytes, mediaType: row.mime } : null;
  } catch { return null; }
  finally { db?.close(); }
}
