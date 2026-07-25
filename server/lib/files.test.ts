import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OutsideHomeError } from "./dirs";
import { contentTypeFor, isViewable, readWithinHome } from "./files";

/**
 * Written under the home directory, because that is the boundary being tested;
 * `/tmp` would be outside it and every read would fail for the wrong reason.
 */
const dir = await mkdtemp(join(homedir(), ".herdrui-files-test-"));
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

  test("refuses anything outside the home directory", async () => {
    expect(readWithinHome({ path: "/etc/passwd" })).rejects.toThrow(OutsideHomeError);
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
