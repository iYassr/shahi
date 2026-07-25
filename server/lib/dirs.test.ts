import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { OutsideHomeError, collapseHome, expandHome, listDirectories, resolveWithinHome } from "./dirs";

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
    const listing = await listDirectories("~");
    expect(listing.display).toBe("~");
    expect(listing.parent).toBeNull();
    expect(listing.entries.length).toBeGreaterThan(0);
    for (const entry of listing.entries) {
      expect(entry.display.startsWith("~/")).toBe(true);
    }
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
