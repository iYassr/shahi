import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { openReadOnly } from "./foreign-sqlite";

describe("another program's WAL database", () => {
  const root = mkdtempSync(join(tmpdir(), "shahi-foreign-sqlite-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const names = (path: string) => {
    const db = openReadOnly(path);
    try { return db.query("SELECT name FROM threads ORDER BY rowid").all(); } finally { db.close(); }
  };
  const create = (path: string) => {
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE threads (name TEXT)");
    db.exec("INSERT INTO threads VALUES ('first')");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return db;
  };

  // Codex removes these when it closes state_5.sqlite, and macOS's SQLite then
  // refused a read-only open; Linux opens it either way.
  test("is read while its owner has it closed", () => {
    const path = join(root, "closed?#%.sqlite");
    create(path).close();
    for (const suffix of ["-shm", "-wal"]) rmSync(path + suffix, { force: true });
    expect(names(path)).toEqual([{ name: "first" }]);
  });

  // Reading the main file alone, as the fallback does, would miss "second".
  test("reads commits still waiting in its log", () => {
    const path = join(root, "pending.sqlite"), copy = join(root, "copy.sqlite");
    const db = create(path);
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("INSERT INTO threads VALUES ('second')");
    // The copy has the log but not its index, as when its owner was killed.
    copyFileSync(path, copy);
    copyFileSync(`${path}-wal`, `${copy}-wal`);
    db.close();
    expect(names(copy)).toEqual([{ name: "first" }, { name: "second" }]);
  });
});
