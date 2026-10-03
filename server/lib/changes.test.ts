/**
 * The Changes view (October 2026), against real repositories made here: the
 * owner asked to see what an agent changed, as a diff, from the phone.
 *
 * Git's settings are the test's own: the developer's global ones (an
 * fsmonitor, `status.showUntrackedFiles`, a filter) must not decide what a
 * test sees. Children write nowhere but a file (docs/on-a-mac.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRows } from "@shahi/shared";
import { ChangesError, fileDiff, paneChanges } from "./changes";

const scratch = mkdtempSync(join(tmpdir(), "shahi-changes-"));
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** Git for setting a repository up, with nothing of the caller's Git environment. */
function git(cwd: string, ...args: string[]): void {
  const env: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] ??= value;
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

let made = 0;
/** A repository with `files` committed on `main`. */
function repository(files: Record<string, string | Uint8Array> = {}): string {
  const dir = join(scratch, `repo-${made++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [path, body] of Object.entries(files)) write(dir, path, body);
  if (Object.keys(files).length) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
  }
  return dir;
}
function write(dir: string, path: string, body: string | Uint8Array): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
}
const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join("\n") + "\n";

describe("the list of changes", () => {
  test("names each changed file's status and counts its lines, against the last commit", async () => {
    const dir = repository({
      "a.txt": "one\ntwo\nthree\n",
      "gone.txt": "keep\n",
      "old.txt": "move me\nplease\n",
      "image.bin": new Uint8Array([0, 1, 2, 3]),
    });
    write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
    rmSync(join(dir, "gone.txt"));
    git(dir, "mv", "old.txt", "new.txt");
    write(dir, "staged.txt", "staged\n");
    git(dir, "add", "staged.txt");
    write(dir, "notes/todo.md", "first\nsecond");
    write(dir, "image.bin", new Uint8Array([0, 9, 9]));

    const changes = await paneChanges(join(dir, "notes"));
    expect(changes.repository).toMatchObject({ name: dir.split("/").pop(), branch: "main" });
    expect(changes.repository!.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(changes.files).toEqual([
      { path: "a.txt", status: "modified", added: 2, removed: 1 },
      { path: "gone.txt", status: "deleted", added: 0, removed: 1 },
      // Binary: Git counts no lines, and neither does Shahi.
      { path: "image.bin", status: "modified", added: null, removed: null },
      { path: "new.txt", from: "old.txt", status: "renamed", added: 0, removed: 0 },
      // The last line has no newline and still counts.
      { path: "notes/todo.md", status: "untracked", added: 2, removed: 0 },
      { path: "staged.txt", status: "added", added: 1, removed: 0 },
    ]);
    expect(changes.omitted).toBe(0);
    expect(changes.note).toBeUndefined();
  });

  test("a folder outside any repository is said calmly, not as an error", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    expect(await paneChanges(plain)).toEqual({
      repository: null, note: "This folder is not in a Git repository, so there are no changes to show.", files: [], omitted: 0,
    });
    expect((await paneChanges(null)).note).toBe("This pane has not said which folder it is in.");
    expect((await paneChanges(join(scratch, "deleted-since"))).note).toBe("This pane's folder is not there any more.");
  });

  test("no changes since the last commit is an empty list under the repository", async () => {
    const changes = await paneChanges(repository({ "a.txt": "a\n" }));
    expect(changes.repository?.branch).toBe("main");
    expect(changes.files).toEqual([]);
  });

  test("a repository with no commit yet compares with nothing", async () => {
    const dir = repository();
    write(dir, "staged.txt", "a\nb\n");
    git(dir, "add", "staged.txt");
    write(dir, "loose.txt", "c\n");
    const changes = await paneChanges(dir);
    expect(changes.repository).toMatchObject({ branch: "main", commit: null });
    expect(changes.files).toEqual([
      { path: "loose.txt", status: "untracked", added: 1, removed: 0 },
      { path: "staged.txt", status: "added", added: 2, removed: 0 },
    ]);
    expect((await fileDiff(dir, "staged.txt")).lines).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
  });

  test("a detached checkout names its commit and no branch", async () => {
    const dir = repository({ "a.txt": "a\n" });
    git(dir, "checkout", "-q", "--detach");
    const changes = await paneChanges(dir);
    expect(changes.repository?.branch).toBeNull();
    expect(changes.repository?.commit).toMatch(/^[0-9a-f]{7}$/);
  });

  test("a repository that says not to list untracked files is obeyed", async () => {
    const dir = repository({ "a.txt": "a\n" });
    git(dir, "config", "status.showUntrackedFiles", "no");
    write(dir, "new.txt", "x\n");
    write(dir, "a.txt", "b\n");
    expect((await paneChanges(dir)).files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  test("a repository whose work tree is outside the home and temp folders is not read", async () => {
    const dir = repository({ "a.txt": "a\n" });
    git(dir, "config", "core.worktree", "/");
    expect((await paneChanges(dir)).note).toBe("This repository is outside your home folder, so Shahi will not read it.");
  });

  test("a nested repository is listed as a folder and not opened", async () => {
    const dir = repository({ "a.txt": "a\n" });
    repositoryAt(join(dir, "inner"));
    const changes = await paneChanges(dir);
    expect(changes.files).toEqual([{ path: "inner/", status: "untracked", added: null, removed: null }]);
    expect((await fileDiff(dir, "inner/")).note).toBe("This folder holds a Git repository of its own, so its changes are not listed here.");
  });
});

function repositoryAt(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "f"), "x\n");
}

describe("one file's diff", () => {
  test("a modified file's lines, numbered from their hunk", async () => {
    const dir = repository({ "a.txt": "one\ntwo\nthree\n" });
    write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
    const diff = await fileDiff(dir, "a.txt");
    expect(diff).toEqual({ path: "a.txt", status: "modified", lines: ["@@ -1,3 +1,4 @@", " one", "-two", "+TWO", " three", "+four"], omitted: 0 });
    expect(diffRows(diff.lines).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ["hunk", undefined, undefined], ["context", 1, 1], ["removed", 2, undefined], ["added", undefined, 2], ["context", 3, 3], ["added", undefined, 4],
    ]);
  });

  test("an untracked file reads as all added, and a deleted one as all removed", async () => {
    const dir = repository({ "gone.txt": "a\nb\n" });
    rmSync(join(dir, "gone.txt"));
    write(dir, "new.txt", "x\ny");
    expect((await fileDiff(dir, "new.txt")).lines).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y", "\\ No newline at end of file"]);
    expect(await fileDiff(dir, "gone.txt")).toMatchObject({ status: "deleted", lines: ["@@ -1,2 +0,0 @@", "-a", "-b"] });
  });

  test("a renamed file shows its edits under its new name", async () => {
    const dir = repository({ "old.txt": lines(20, "line") });
    git(dir, "mv", "old.txt", "new.txt");
    write(dir, "new.txt", lines(20, "line").replace("line 5\n", "line five\n"));
    const diff = await fileDiff(dir, "new.txt");
    expect(diff).toMatchObject({ path: "new.txt", from: "old.txt", status: "renamed" });
    expect(diff.lines).toContain("-line 5");
    expect(diff.lines).toContain("+line five");
  });

  test("a binary file says so instead of showing its bytes", async () => {
    const dir = repository({ "image.bin": new Uint8Array([0, 1, 2]) });
    write(dir, "image.bin", new Uint8Array([0, 4, 5]));
    expect(await fileDiff(dir, "image.bin")).toMatchObject({ lines: [], omitted: 0, note: "This is a binary file, so there are no lines to show." });
  });

  test("a huge diff is cut by lines and by bytes, and says how many more", async () => {
    const dir = repository({ "many.txt": lines(10_000, "old"), "wide.txt": lines(2_000, "w".repeat(900)) });
    write(dir, "many.txt", lines(10_000, "new"));
    const many = await fileDiff(dir, "many.txt");
    expect(many.lines).toHaveLength(3000);
    // The hunk header, 10,000 removed and 10,000 added.
    expect(many.lines.length + many.omitted).toBe(20_001);

    write(dir, "wide.txt", lines(2_000, "v".repeat(900)));
    const wide = await fileDiff(dir, "wide.txt");
    expect(Buffer.byteLength(JSON.stringify(wide.lines))).toBeLessThanOrEqual(256 * 1024 + 2);
    expect(wide.lines.length).toBeLessThan(300);
    expect(wide.lines.length + wide.omitted).toBe(4_001);
  });

  test("a line too long to send is cut, and says how much is missing", async () => {
    const dir = repository({ "min.js": "x\n" });
    write(dir, "min.js", `${"a".repeat(5000)}\n`);
    const line = (await fileDiff(dir, "min.js")).lines.find((l) => l.startsWith("+"))!;
    expect(line).toBe(`+${"a".repeat(999)} … 4,001 more characters`);
  });

  test("a path Git did not list is refused before anything is read", async () => {
    const dir = repository({ "a.txt": "a\n", "same.txt": "s\n" });
    write(dir, "a.txt", "b\n");
    for (const path of ["../../../etc/passwd", "/etc/passwd", "same.txt", "", "a.txt/"]) {
      const refusal = await fileDiff(dir, path).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(ChangesError);
      expect(refusal).toMatchObject({ status: 404, code: "not_changed" });
    }
  });

  test("a file named like a pattern is compared alone", async () => {
    // As a pattern `x?.txt` matches `x1.txt` too, which Git would print first.
    const dir = repository({ "x?.txt": "pattern\n", "x1.txt": "one\n" });
    write(dir, "x?.txt", "PATTERN\n");
    write(dir, "x1.txt", "ONE\n");
    expect((await fileDiff(dir, "x?.txt")).lines).toEqual(["@@ -1 +1 @@", "-pattern", "+PATTERN"]);
  });
});

describe("a repository's own settings", () => {
  test("run no program while it is listed or diffed, and the index is never written", async () => {
    const marks = join(scratch, "marks");
    mkdirSync(marks);
    const script = (name: string) => {
      const path = join(scratch, `${name}.sh`);
      // Each leaves a mark if it runs, and passes its input through.
      writeFileSync(path, `#!/bin/sh\ntouch "${marks}/${name}"\ncat\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const dir = repository({ ".gitattributes": "* filter=evil diff=evil\n", "a.txt": "a\n" });
    for (const [key, value] of [
      ["core.fsmonitor", script("fsmonitor")],
      ["filter.evil.clean", script("clean")],
      ["filter.evil.smudge", script("smudge")],
      ["filter.evil.process", script("process")],
      ["filter.evil.required", "true"],
      ["diff.evil.command", script("command")],
      ["diff.evil.textconv", script("textconv")],
      ["diff.external", script("external")],
      ["core.pager", script("pager")],
    ] as const) git(dir, "config", key, value);
    writeFileSync(join(dir, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch "${marks}/hook"\n`);
    chmodSync(join(dir, ".git", "hooks", "post-index-change"), 0o755);
    write(dir, "a.txt", "b\n");
    write(dir, "new.txt", "n\n");
    // Older than the index, so Git must read the file again and would
    // refresh the index if it could.
    const index = join(dir, ".git", "index");
    const before = statSync(index).mtimeMs;
    utimesSync(join(dir, "a.txt"), new Date(2001, 0, 1), new Date(2001, 0, 1));

    const changes = await paneChanges(dir);
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([["a.txt", "modified"], ["new.txt", "untracked"]]);
    expect((await fileDiff(dir, "a.txt")).lines).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
    expect((await fileDiff(dir, "new.txt")).lines).toEqual(["@@ -0,0 +1 @@", "+n"]);

    expect(readdirSync(marks)).toEqual([]);
    expect(statSync(index).mtimeMs).toBe(before);
  });
});
