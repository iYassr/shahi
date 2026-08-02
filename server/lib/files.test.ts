import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OutsideHomeError } from "./dirs";
import { contentTypeFor, isViewable, readWithinHome } from "./files";

/** Under the home directory, which is one of the two roots a read may come from. */
const dir = await mkdtemp(join(homedir(), ".shahi-files-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("contentTypeFor", () => {
  test("names the types a phone can open", () => {
    expect(contentTypeFor("/a/notes.md")).toStartWith("text/plain");
    expect(contentTypeFor("/a/shot.png")).toBe("image/png");
    expect(contentTypeFor("/a/report.pdf")).toBe("application/pdf");
  });

  test("serves markup as text, never as itself", () => {
    // Otherwise an agent-written page would run script on this origin, with the
    // session cookie attached.
    expect(contentTypeFor("/a/page.html")).toStartWith("text/plain");
    expect(contentTypeFor("/a/diagram.svg")).toStartWith("text/plain");
  });

  test("a download is bytes, whatever it is", () => {
    expect(contentTypeFor("/a/shot.png", { download: true })).toBe("application/octet-stream");
  });

  test("anything unrecognised is bytes too", () => {
    expect(contentTypeFor("/a/thing.xyz")).toBe("application/octet-stream");
  });
});

describe("isViewable", () => {
  test("text, images and PDFs can be shown", () => {
    expect(isViewable("/a/notes.md")).toBe(true);
    expect(isViewable("/a/shot.jpg")).toBe(true);
    expect(isViewable("/a/report.pdf")).toBe(true);
  });

  test("a spreadsheet is for downloading", () => {
    expect(isViewable("/a/book.xlsx")).toBe(false);
  });
});

describe("readWithinHome", () => {
  test("reads a file the agent wrote", async () => {
    const path = join(dir, "notes.md");
    await writeFile(path, "# hello");

    const file = await readWithinHome({ path });
    expect(new TextDecoder().decode(file.bytes)).toBe("# hello");
    expect(file.name).toBe("notes.md");
    expect(file.contentType).toStartWith("text/plain");
  });

  test("reads a file from the temp directory too", async () => {
    // Where agents put screenshots and scratch output — the files most worth
    // glancing at on a phone, and the ones this used to refuse.
    const scratch = await mkdtemp(join(tmpdir(), "shahi-files-test-"));
    try {
      const path = join(scratch, "shot.png");
      await writeFile(path, "not really a png");
      const file = await readWithinHome({ path });
      expect(file.contentType).toBe("image/png");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("refuses anything outside both roots", async () => {
    expect(readWithinHome({ path: "/etc/passwd" })).rejects.toThrow(OutsideHomeError);
    expect(readWithinHome({ path: "/usr/bin/env" })).rejects.toThrow(OutsideHomeError);
  });

  test("refuses a symlink that points out of them", async () => {
    // Resolved before the check, so a link cannot be used as a door.
    const link = join(dir, "escape");
    await symlink("/etc/passwd", link);
    expect(readWithinHome({ path: link })).rejects.toThrow(OutsideHomeError);
  });

  test("refuses to be walked out of it", async () => {
    expect(readWithinHome({ path: `${dir}/../../../etc/passwd` })).rejects.toThrow(
      OutsideHomeError,
    );
  });

  test("refuses a directory", async () => {
    expect(readWithinHome({ path: dir })).rejects.toThrow(OutsideHomeError);
  });

  test("refuses a file that is not there", async () => {
    expect(readWithinHome({ path: join(dir, "absent.txt") })).rejects.toThrow();
  });

  test("a download of a text file is still bytes", async () => {
    const path = join(dir, "notes.md");
    await writeFile(path, "# hello");
    expect((await readWithinHome({ path, download: true })).contentType).toBe(
      "application/octet-stream",
    );
  });
});
