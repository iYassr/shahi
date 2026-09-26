import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OutsideHomeError, collapseHome, expandHome, folderProblem, listDirectories, resolveWithinHome } from "./dirs";

const HOME = homedir();

describe("home shorthand", () => {
  test("expands ~", () => {
    expect(expandHome("~")).toBe(HOME);
    expect(expandHome("~/projects")).toBe(`${HOME}/projects`);
  });

  test("leaves absolute paths alone", () => {
    expect(expandHome("/etc")).toBe("/etc");
  });

  test("collapses back for display", () => {
    expect(collapseHome(HOME)).toBe("~");
    expect(collapseHome(`${HOME}/projects`)).toBe("~/projects");
    expect(collapseHome("/etc")).toBe("/etc");
  });

  // `~foo` is a different user's home in shell syntax, not a subdirectory of
  // ours; treating it as shorthand would silently point somewhere unexpected.
  test("does not treat ~foo as home-relative", () => {
    expect(expandHome("~other")).toBe("~other");
  });
});

describe("staying inside home", () => {
  test("resolves a real directory", async () => {
    expect(await resolveWithinHome("~")).toBe(HOME);
  });

  test("refuses to climb out with ..", async () => {
    expect(resolveWithinHome("~/../..")).rejects.toThrow(OutsideHomeError);
    expect(resolveWithinHome("/etc")).rejects.toThrow(OutsideHomeError);
  });

  test("refuses a path that does not exist", async () => {
    expect(resolveWithinHome("~/definitely-not-a-real-directory-9f3a")).rejects.toThrow();
  });
});

describe("listDirectories", () => {
  test("lists sub-directories of home with display paths", async () => {
    // A fresh VM can have only hidden directories; provide the visible entry
    // this assertion needs instead of depending on the developer's home.
    const fixture = mkdtempSync(join(HOME, "shahi-dirs-test-"));
    try {
      const listing = await listDirectories("~");
      expect(listing.display).toBe("~");
      expect(listing.parent).toBeNull();
      expect(listing.entries.length).toBeGreaterThan(0);
      for (const entry of listing.entries) {
        expect(entry.display.startsWith("~/")).toBe(true);
      }
      expect(listing.entries.some((entry) => entry.display === collapseHome(fixture))).toBe(true);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  test("hides dotfiles", async () => {
    const listing = await listDirectories("~");
    expect(listing.entries.some((e) => e.name.startsWith("."))).toBe(false);
  });

  test("sorts naturally", async () => {
    const names = (await listDirectories("~")).entries.map((e) => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(names).toEqual(sorted);
  });

  test("offers a parent below home", async () => {
    const home = await listDirectories("~");
    const first = home.entries[0];
    if (!first) return;
    expect((await listDirectories(first.display)).parent).toBe("~");
  });
});

// Review finding F90: with $HOME a symlink (`/home` -> `/var/home`), every
// resolved path was compared with the unresolved name, so the folder picker
// refused even `~`. Home is read once at import, so this runs in a process
// whose HOME is the symlink.
test("a home directory reached through a symlink can still be browsed", () => {
  const root = mkdtempSync(join(tmpdir(), "shahi-symlinked-home-"));
  try {
    const real = join(root, "real-home");
    mkdirSync(join(real, "projects", "app"), { recursive: true });
    const link = join(root, "home");
    symlinkSync(real, link);
    const script = `
      const { listDirectories } = await import(${JSON.stringify(join(import.meta.dir, "dirs.ts"))});
      const home = await listDirectories("~");
      const projects = await listDirectories("~/projects");
      console.log(JSON.stringify({ home, projects }));
    `;
    const run = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, HOME: link } });
    expect(run.stderr.toString()).toBe("");
    const { home, projects } = JSON.parse(run.stdout.toString());
    expect(home.display).toBe("~");
    expect(home.parent).toBeNull();
    // Bun may create its own folders under a fresh home, so only ours is named.
    expect(home.entries.map((e: { display: string }) => e.display)).toContain("~/projects");
    expect(projects.parent).toBe("~");
    expect(projects.entries.map((e: { display: string }) => e.display)).toEqual(["~/projects/app"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * herdr uses $HOME for any folder it cannot enter, and says nothing, so a new
 * space or agent in a deleted project landed in the home directory
 * (pre-release bug hunt, B9).
 */
describe("folderProblem", () => {
  const root = mkdtempSync(join(tmpdir(), "shahi-folder-"));

  test("a folder that is there, anywhere on the computer, is fine", async () => {
    expect(await folderProblem(root)).toBeNull();
  });

  test("no folder is herdr's default, and fine", async () => {
    expect(await folderProblem(null)).toBeNull();
    expect(await folderProblem(undefined)).toBeNull();
    expect(await folderProblem("")).toBeNull();
  });

  test("a folder that is not there says so", async () => {
    expect(await folderProblem(join(root, "deleted-project"))).toBe("That folder does not exist on this computer.");
  });

  test("a path through a file says the folder is not there", async () => {
    writeFileSync(join(root, "notes.txt"), "x");
    expect(await folderProblem(join(root, "notes.txt"))).toBe("That path is a file, not a folder.");
    expect(await folderProblem(join(root, "notes.txt", "inside"))).toBe("That folder does not exist on this computer.");
  });

  test("home shorthand and relative paths are refused as before", async () => {
    expect(await folderProblem("~/project")).toBe("cwd must be an absolute path");
    expect(await folderProblem("project")).toBe("cwd must be an absolute path");
    expect(await folderProblem(7)).toBe("cwd must be an absolute path");
  });

  test.skipIf(process.getuid?.() === 0)("a folder that cannot be entered is refused", async () => {
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o600);
    try {
      expect(await folderProblem(locked)).toBe("That folder cannot be opened on this computer.");
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
