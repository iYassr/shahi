/**
 * OpenCode 2's session projection: `session_v2`, and `session_message` rows of
 * typed messages in `seq` order. OpenCode 2.2.0 shipped on 27 October 2026
 * writing only these tables, and Reader found no conversation for any OpenCode
 * it ran (the agent journeys, on the owner's Linux computer, the next day).
 * Read from OpenCode's source at v2.2.0 (packages/schema/src/session-message.ts,
 * packages/core/src/session/sql.ts) and measured against that computer's
 * database. The v1 reader's rules hold: only herdr's reported session id
 * selects a conversation, every field is cut to size inside SQLite, and a
 * message is drawn only as OpenCode's own TUI draws it
 * (packages/tui/src/routes/session/index.tsx); any other type is dropped.
 */
import type { Database } from "bun:sqlite";
import { basename, isAbsolute } from "node:path";
import type { LogBlock, LogMessage, SessionLog } from "@shahi/shared";
import { summariseToolInput } from "./session-log";
import {
  boundedBlocks, boundedQuestions, excerpt, fileBlock, filePath, ID, MAX_PAGE_READ, MAX_RESULT, MAX_TEXT, obj, open,
  parse, SESSION, sqlId, sqlString, str, time, type OpenCodeTranscript,
} from "./opencode-log";

const TOOL_STATES = ["streaming", "running", "completed", "error"];

const text = (path: string) => sqlString("m.data", path, true);
const SKILL_NAME = sqlString("s.value", "$.name", true);
/** The same allowlist as `render`, so COUNT and the API 5 clients' paging agree with what is drawn. */
const VISIBLE = `${sqlId("m.id")} AND json_valid(m.data) AND CASE m.type
  WHEN 'user' THEN ${text("$.text")} OR json_array_length(m.data,'$.files') > 0 OR json_array_length(m.data,'$.agents') > 0
    OR (json_type(m.data,'$.skills')='array' AND EXISTS (SELECT 1 FROM json_each(m.data,'$.skills') s WHERE json_valid(s.value) AND ${SKILL_NAME}))
  WHEN 'assistant' THEN ${text("$.error.message")} OR (json_type(m.data,'$.content')='array' AND EXISTS (
    SELECT 1 FROM json_each(m.data,'$.content') c WHERE json_valid(c.value) AND (
      (json_extract(c.value,'$.type') IN ('text','reasoning') AND ${sqlString("c.value", "$.text", true)})
      OR (json_extract(c.value,'$.type')='tool' AND ${sqlString("c.value", "$.name")}
        AND json_extract(c.value,'$.state.status') IN (${TOOL_STATES.map(s => `'${s}'`).join(",")})))))
  WHEN 'synthetic' THEN ${text("$.description")} OR json_extract(m.data,'$.metadata.source') IN ('subagent','shell')
  WHEN 'system' THEN ${text("$.description")}
  WHEN 'skill' THEN ${text("$.name")}
  WHEN 'shell' THEN ${text("$.command")}
  WHEN 'compaction' THEN json_extract(m.data,'$.status')='completed'
    OR (json_extract(m.data,'$.status')='failed' AND json_extract(m.data,'$.error.type') IS NOT 'aborted' AND ${text("$.error.message")})
  WHEN 'agent-switched' THEN ${text("$.agent")}
  WHEN 'model-switched' THEN ${text("$.model.id")}
  WHEN 'location-switched' THEN ${text("$.location.directory")}
  WHEN 'idle' THEN ${text("$.error.message")}
  ELSE 0 END`;

/** One past the limit, so `excerpt` can tell a cut from a fit. */
const cut = (data: string, path: string, max: number) =>
  `CASE WHEN json_type(${data},'${path}')='text' THEN substr(json_extract(${data},'${path}'),1,${max + 1}) END`;
const ROW = `SELECT m.id, m.type, m.time_created AS created,
  ${cut("m.data", "$.text", MAX_TEXT)} AS text, ${cut("m.data", "$.description", 4096)} AS description,
  json_extract(m.data,'$.metadata.source') AS source, ${cut("m.data", "$.metadata.agent", 200)} AS actor,
  ${cut("m.data", "$.metadata.state", 40)} AS state, ${cut("m.data", "$.name", 200)} AS name,
  ${cut("m.data", "$.command", MAX_RESULT)} AS command, ${cut("m.data", "$.status", 40)} AS status,
  json_extract(m.data,'$.exit') AS exit, ${cut("m.data", "$.output.output", MAX_RESULT)} AS output,
  ${cut("m.data", "$.error.message", MAX_RESULT)} AS error, ${cut("m.data", "$.reason", 40)} AS reason,
  ${cut("m.data", "$.agent", 200)} AS agent, ${cut("m.data", "$.previous", 200)} AS previous,
  ${cut("m.data", "$.model.id", 200)} AS model, ${cut("m.data", "$.location.directory", 4096)} AS directory,
  (SELECT json_group_array(json_object('mime', substr(json_extract(f.value,'$.mime'),1,200), 'name', substr(json_extract(f.value,'$.name'),1,256),
    'uri', CASE WHEN json_extract(f.value,'$.source.type')='uri' AND length(json_extract(f.value,'$.source.uri')) <= 4096 THEN json_extract(f.value,'$.source.uri') END))
    FROM (SELECT value FROM json_each(m.data,'$.files') WHERE json_type(m.data,'$.files')='array' AND json_valid(value) LIMIT 32) f) AS files,
  (SELECT json_group_array(substr(json_extract(a.value,'$.name'),1,200))
    FROM (SELECT value FROM json_each(m.data,'$.agents') WHERE json_type(m.data,'$.agents')='array' AND json_valid(value) LIMIT 32) a) AS agents,
  (SELECT json_group_array(substr(json_extract(s.value,'$.name'),1,200))
    FROM (SELECT s.value FROM json_each(m.data,'$.skills') s WHERE json_type(m.data,'$.skills')='array' AND json_valid(s.value) AND ${SKILL_NAME} LIMIT 32) s) AS skills
  FROM session_message m`;
/** An assistant step's text, reasoning and tool calls, each projected before it reaches JavaScript. */
const CONTENT = `SELECT json_extract(c.value,'$.type') AS type, ${cut("c.value", "$.text", MAX_TEXT)} AS text,
  ${cut("c.value", "$.name", 200)} AS name, json_extract(c.value,'$.state.status') AS status,
  CASE WHEN json_type(c.value,'$.state.input')='object' AND length(json_extract(c.value,'$.state.input')) <= 65536 THEN json_extract(c.value,'$.state.input') END AS input,
  (SELECT substr(group_concat(json_extract(r.value,'$.text'), char(10)),1,${MAX_RESULT + 1}) FROM json_each(c.value,'$.state.content') r
    WHERE json_valid(r.value) AND json_extract(r.value,'$.type')='text' AND json_type(r.value,'$.text')='text') AS output,
  (SELECT json_group_array(coalesce(substr(json_extract(r.value,'$.name'),1,256), substr(json_extract(r.value,'$.mime'),1,200)))
    FROM (SELECT value FROM json_each(c.value,'$.state.content') WHERE json_valid(value) AND json_extract(value,'$.type')='file' LIMIT 32) r) AS files,
  ${cut("c.value", "$.state.error.message", MAX_RESULT)} AS error
  FROM session_message m, json_each(m.data,'$.content') c
  WHERE m.id = ? AND m.session_id = ? AND json_valid(m.data) AND json_type(m.data,'$.content')='array' AND json_valid(c.value)
  ORDER BY CAST(c.key AS INTEGER) LIMIT 513`;

type Row = Record<string, unknown>;
const list = (value: unknown): unknown[] => {
  try { const parsed = JSON.parse(str(value)); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
const titlecase = (value: string) => value.replace(/(^|[\s_-])(\w)/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());

function toolBlock(item: Row): LogBlock | null {
  const name = str(item.name), status = str(item.status);
  if (!name || !TOOL_STATES.includes(status)) return null;
  const input = parse(item.input);
  const path = str(input.path) || str(input.filePath);
  const files = list(item.files).flatMap(file => str(file) ? [`File: ${excerpt(file, 256)}`] : []);
  const output = [
    status === "error" ? str(item.error) : "",
    str(item.output),
    status === "completed" && name === "write" ? excerpt(input.content, MAX_RESULT) : "",
    ...files,
  ].filter(Boolean).join("\n\n");
  const result = excerpt(output, MAX_RESULT);
  return {
    kind: "tool", name: excerpt(name, 200), summary: summariseToolInput(name, { ...input, file_path: path || undefined }),
    ...(path && path.length <= 4096 && isAbsolute(path) ? { file: { path, name: excerpt(basename(path), 256) } } : {}),
    ...boundedQuestions(name === "question" ? "AskUserQuestion" : name, input),
    result: status === "completed" || status === "error" ? { text: result, isError: status === "error", truncated: result !== output, images: [] } : null,
  };
}

/** What the TUI's synthetic notice says: a subagent or background command finishing, or the notice's own words. */
function syntheticText(row: Row): string {
  const description = str(row.source) === "shell" ? str(row.description).replace(/\s+/g, " ").trim() : str(row.description);
  if (row.source !== "subagent" && row.source !== "shell") return description;
  const actor = row.source === "shell" ? "Shell" : titlecase(str(row.actor) || "subagent");
  const state = str(row.state);
  const status = state === "completed" ? "finished" : state === "error" ? "failed" : state || "finished";
  return `${actor} ${status}${description ? ` · ${description}` : ""}`;
}

function shellBlocks(row: Row): LogBlock[] {
  const exit = typeof row.exit === "number" ? row.exit : undefined;
  const failure = row.status === "killed" ? "Command cancelled" : row.status === "timeout" ? "Command timed out"
    : exit !== undefined && exit !== 0 ? `Command exited with code ${exit}` : "";
  // Written the way the TUI and Claude Code draw a command the person ran: `! ls`.
  return [`! ${excerpt(row.command, MAX_RESULT)}`, excerpt(row.output, MAX_RESULT), failure]
    .filter(Boolean).map(text => ({ kind: "text" as const, text }));
}

function userBlocks(row: Row): LogBlock[] {
  const blocks: LogBlock[] = [];
  if (str(row.text).trim()) blocks.push({ kind: "text", text: excerpt(row.text) });
  for (const value of list(row.files)) {
    const file = obj(value), mime = str(file.mime), name = str(file.name);
    // Images are named, not shown: Reader has no route to OpenCode 2's media yet.
    const local = filePath({ url: str(file.uri) });
    if (local) blocks.push(fileBlock(local, "Attachment"));
    else if (name || mime) blocks.push({ kind: "text", text: `Attachment: ${excerpt(name || mime, 256)}${mime && name && name !== mime ? ` (${mime})` : ""}` });
  }
  for (const agent of list(row.agents)) if (str(agent)) blocks.push({ kind: "text", text: `@${excerpt(agent, 200)}` });
  // The TUI shows selected skill names even without prose. Instructions in
  // those attachments are model context, so only bounded names are projected.
  for (const skill of list(row.skills)) if (str(skill)) blocks.push({ kind: "text", text: `Skill: ${excerpt(skill, 200)}` });
  return blocks;
}

function render(row: Row, content: Row[], sessionId: string): LogMessage | null {
  const id = `${sessionId}:${str(row.id)}`, at = time(row.created);
  const note = (text: string): LogMessage | null => text ? { id, role: "system", at, blocks: [{ kind: "text", text }] } : null;
  switch (row.type) {
    case "user": {
      const blocks = userBlocks(row);
      return blocks.length ? { id, role: "you", at, blocks: boundedBlocks(blocks) } : null;
    }
    case "shell": return { id, role: "you", at, blocks: shellBlocks(row) };
    case "assistant": {
      const blocks: LogBlock[] = [];
      for (const item of content) {
        if (item.type === "text" && str(item.text).trim()) blocks.push({ kind: "text", text: excerpt(item.text) });
        else if (item.type === "reasoning" && str(item.text).trim()) blocks.push({ kind: "thinking", text: excerpt(item.text) });
        else if (item.type === "tool") { const block = toolBlock(item); if (block) blocks.push(block); }
      }
      if (str(row.error).trim()) blocks.push({ kind: "text", text: excerpt(row.error, MAX_RESULT) });
      return blocks.length ? { id, role: "agent", at, blocks: boundedBlocks(blocks) } : null;
    }
    case "synthetic": return note(excerpt(syntheticText(row), 4096));
    case "system": return note(excerpt(row.description, 4096));
    case "skill": return note(str(row.name) && `Skill ${excerpt(row.name, 200)}`);
    case "compaction":
      if (row.status === "completed") return note(row.reason === "auto" ? "Conversation compacted automatically." : "Conversation compacted.");
      return note(str(row.error) && `Compaction failed: ${excerpt(row.error, MAX_RESULT)}`);
    case "agent-switched": {
      const agent = titlecase(str(row.agent)), previous = titlecase(str(row.previous));
      return note(agent && (previous && previous !== agent ? `Switched agent from ${previous} to ${agent}` : `Switched agent to ${agent}`));
    }
    case "model-switched": return note(str(row.model) && `Switched model to ${excerpt(row.model, 200)}`);
    case "location-switched": return note(str(row.directory) && `Moved to ${excerpt(row.directory, 4096)}`);
    case "idle": return note(excerpt(row.error, MAX_RESULT));
    default: return null;
  }
}

/**
 * OpenCode 2's undo deletes the undone rows when the next prompt commits it
 * and records nothing of having done so (RevertEvent.Committed in
 * packages/core/src/session/projector.ts), where 1.x kept removal events.
 * Rows are only ever appended with a rising `seq` or deleted as a suffix, so
 * fewer rows at or below the highest `seq` last read means some were removed,
 * and the page's path changes so API 5 clients drop the history they hold.
 * Held in memory: an undo committed while the sidecar was stopped is missed.
 */
const revisions = new Map<string, { seq: number; count: number; revision: number }>();
const MAX_REVISIONS = 256;
function prunedRevision(db: Database, source: OpenCodeTranscript): number {
  const key = `${source.databasePath}#${source.sessionId}`;
  const held = revisions.get(key);
  const now = db.query("SELECT count(*) AS count, max(seq) AS seq FROM session_message WHERE session_id = ?").get(source.sessionId) as { count: number; seq: number | null };
  let revision = held?.revision ?? 0;
  if (held && (db.query("SELECT count(*) AS count FROM session_message WHERE session_id = ? AND seq <= ?").get(source.sessionId, held.seq) as { count: number }).count < held.count) revision++;
  revisions.delete(key);
  revisions.set(key, { seq: now.seq ?? 0, count: now.count, revision });
  if (revisions.size > MAX_REVISIONS) revisions.delete(revisions.keys().next().value!);
  return revision;
}

export async function readOpenCodeV2Log(source: OpenCodeTranscript, options: { limit?: number; before?: number } = {}): Promise<SessionLog | null> {
  if (!SESSION.test(source.sessionId)) return null;
  let db: Database | undefined;
  try {
    db = open(source);
    return db.transaction(() => {
      const session = db!.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(source.sessionId);
      if (!session) return null;
      const revision = prunedRevision(db!, source);
      // The TUI hides an undone message and everything after it until the
      // undo is committed or redone, and so does Reader.
      const reverted = str(parse(session.revert).messageID);
      const boundary = reverted ? db!.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(source.sessionId, reverted) : null;
      const where = `m.session_id = ? AND ${VISIBLE}${boundary ? " AND m.seq < ?" : ""}`;
      const params: (string | number)[] = boundary ? [source.sessionId, boundary.seq] : [source.sessionId];
      const total = (db!.query(`SELECT count(*) AS n FROM session_message m WHERE ${where}`).get(...params) as { n: number }).n;
      const end = Number.isSafeInteger(options.before) ? Math.max(0, Math.min(total, options.before!)) : total;
      const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(200, options.limit!)) : 60;
      const rows = db!.query(`${ROW} WHERE ${where} ORDER BY m.seq DESC LIMIT ? OFFSET ?`).all(...params, Math.min(limit, end), total - end) as Row[];
      const messages: LogMessage[] = [];
      let consumed = 0, bytes = 0;
      for (const row of rows) {
        if (bytes >= MAX_PAGE_READ && consumed) break;
        consumed++;
        const content: Row[] = [];
        let contentBytes = 0;
        if (row.type === "assistant") for (const item of db!.query(CONTENT).iterate(str(row.id), source.sessionId) as Iterable<Row>) {
          const size = Buffer.byteLength(JSON.stringify(item));
          if (contentBytes + size > 512 * 1024) {
            content.push({ type: "text", text: "Additional message content exceeds the Reader limit; view it in OpenCode." });
            break;
          }
          content.push(item); contentBytes += size;
        }
        bytes += contentBytes + Buffer.byteLength(JSON.stringify(row));
        const rendered = ID.test(str(row.id)) ? render(row, content, source.sessionId) : null;
        // COUNT promised a message here; an empty page would be asked for again forever.
        messages.unshift(rendered ?? { id: `${source.sessionId}:${str(row.id)}`, role: "system", at: time(row.created), blocks: [{ kind: "text", text: "Message content could not be displayed in Reader. View it in OpenCode." }] });
      }
      return { sessionId: source.sessionId, path: `${source.databasePath}#${source.sessionId}:v2:revision:${revision}${boundary ? `:revert:${reverted}` : ""}`, messages, total, offset: end - consumed };
    })();
  } catch { return null; }
  finally { db?.close(); }
}
