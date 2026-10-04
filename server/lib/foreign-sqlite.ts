import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * Opens another program's SQLite database for reading only.
 *
 * Codex and OpenCode keep theirs in WAL mode, and remove the `-wal` and `-shm`
 * files when they close it. On macOS, where Bun 1.4.0 loads the system SQLite
 * (3.54.0), a read-only open then fails with SQLITE_CANTOPEN. It succeeds once
 * a `-wal` exists, even an empty one. Measured on 2026-10-04: Codex 0.160 had
 * closed `state_5.sqlite`, and a hand-started conversation showed "No messages
 * yet" until something opened the index again. On Linux, where CI runs, Bun's
 * own SQLite (3.51.2) opens every one of those states, so only a Mac shows it.
 *
 * With no `-wal` at all, nothing has written since the last checkpoint, so the
 * main file holds every commit. A writer that starts meanwhile appends to a new
 * log, not to the main file, until it checkpoints. So the main file is read as
 * immutable. That creates nothing beside another program's data, and it cannot
 * checkpoint the program's log on close, as a read-write connection would.
 */
export function openReadOnly(path: string, options: { strict?: boolean } = {}): Database {
  let db: Database | undefined;
  try {
    db = new Database(path, { ...options, readonly: true });
    // The constructor does not open the file: SQLITE_CANTOPEN arrives with the
    // first statement, so one is run here.
    db.query("PRAGMA schema_version").get();
    return db;
  } catch (e) {
    db?.close();
    if ((e as { code?: string }).code !== "SQLITE_CANTOPEN" || existsSync(`${path}-wal`)) throw e;
    // A URI filename, so "?", "#" and "%" in the path are escaped.
    const uri = `file:${path.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}?immutable=1`;
    return new Database(uri, { ...options, readonly: true });
  }
}
