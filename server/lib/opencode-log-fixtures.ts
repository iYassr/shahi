/** Synthetic schema/rows matching OpenCode 1.18.32's v1 TUI projection. */
import { Database } from "bun:sqlite";

export const OPEN_CODE_SESSION = "ses_readerA";
export function createOpenCodeFixture(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY,revert TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id);`);
  db.exec(`CREATE TABLE event (id TEXT PRIMARY KEY,aggregate_id TEXT,seq INTEGER,type TEXT,data TEXT);
    CREATE INDEX event_aggregate_type_seq_idx ON event(aggregate_id,type,seq);`);
  db.run("INSERT INTO session (id) VALUES (?)", [OPEN_CODE_SESSION]);
  return db;
}
export function openCodeFixtureMessage(db: Database, id: string, role: "user" | "assistant", created: number, parts: Record<string, unknown>[], session = OPEN_CODE_SESSION, info: Record<string, unknown> = {}): void {
  db.run("INSERT INTO message VALUES (?,?,?,?,?)", [id, session, created, created, JSON.stringify({ role, time: { created }, ...info })]);
  parts.forEach((part, index) => db.run("INSERT INTO part VALUES (?,?,?,?,?,?)", [str(part.id) || `prt_${id.slice(4)}_${index}`, id, session, created, created, JSON.stringify(part)]));
}
function str(x: unknown) { return typeof x === "string" ? x : ""; }
