/**
 * Who this server is, across restarts.
 *
 * The phone will hold credentials that should survive the server's address
 * changing — a tunnel restarted, a tailnet renamed — so they need something
 * stabler than a URL to bind to. A random id, minted the first time the server
 * starts and kept in the same database as everything else, is that thing.
 */
import type { Database } from "bun:sqlite";

export function serverIdentity(db: Database): string {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("server_id");
  if (row) return row.value;
  const id = crypto.randomUUID();
  db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("server_id", id);
  return id;
}
