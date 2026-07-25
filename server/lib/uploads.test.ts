import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR, UploadTooLarge, safeName, storeUpload } from "./uploads";

/**
 * Every write goes here, never to UPLOAD_DIR.
 *
 * These tests used to write to the real upload directory and then remove it
 * recursively on teardown, which destroyed files a user had genuinely uploaded.
 * A test that can delete production data is worse than no test.
 */
const DIR = join(tmpdir(), `herdrui-uploads-test-${process.pid}`);

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true }).catch(() => {});
});

test("the test directory is not the real one", () => {
  expect(DIR).not.toBe(UPLOAD_DIR);
  expect(DIR.startsWith(tmpdir())).toBe(true);
});

describe("safeName", () => {
  // The name comes from a browser and is hostile until proven otherwise.
  test("strips directory traversal", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("..\\..\\windows\\system32")).toBe("system32");
    expect(safeName("/etc/shadow")).toBe("shadow");
  });

  test("refuses to produce a dotfile", () => {
    expect(safeName(".bashrc")).toBe("bashrc");
    expect(safeName("...")).toBe("upload");
  });

  test("replaces rather than strips unusual characters, so names stay distinct", () => {
    expect(safeName("a b.png")).toBe("a_b.png");
    expect(safeName("a;b.png")).toBe("a_b.png");
    // Replacing keeps these apart; stripping would collapse both to "ab.png".
    expect(safeName("a b.png")).not.toBe(safeName("ab.png"));
  });

  test("keeps ordinary names intact", () => {
    expect(safeName("IMG_4821.HEIC")).toBe("IMG_4821.HEIC");
    expect(safeName("notes-v2.md")).toBe("notes-v2.md");
  });

  test("never returns empty", () => {
    expect(safeName("")).toBe("upload");
    expect(safeName("/")).toBe("upload");
  });

  test("clips absurdly long names", () => {
    expect(safeName("x".repeat(500)).length).toBeLessThanOrEqual(96);
  });
});

describe("storeUpload", () => {
  test("writes into the upload directory and returns an absolute path", async () => {
    const stored = await storeUpload(new File(["hello"], "note.txt", { type: "text/plain" }), Date.now, DIR);
    expect(stored.path.startsWith(DIR)).toBe(true);
    expect(stored.name).toBe("note.txt");
    expect(stored.size).toBe(5);
    expect(await Bun.file(stored.path).text()).toBe("hello");
  });

  // Two photos from a phone are routinely both called IMG_0001.
  test("does not let a second file of the same name overwrite the first", async () => {
    let clock = Date.parse("2026-07-25T10:00:00Z");
    const a = await storeUpload(new File(["one"], "IMG_0001.jpg"), () => clock, DIR);
    clock += 1000;
    const b = await storeUpload(new File(["two"], "IMG_0001.jpg"), () => clock, DIR);

    expect(a.path).not.toBe(b.path);
    expect(await Bun.file(a.path).text()).toBe("one");
    expect(await Bun.file(b.path).text()).toBe("two");
  });

  test("a traversing name still lands inside the upload directory", async () => {
    const stored = await storeUpload(new File(["x"], "../../../etc/passwd"), Date.now, DIR);
    expect(stored.path.startsWith(`${DIR}/`)).toBe(true);
    expect(stored.path).not.toContain("..");
  });

  test("rejects a file over the limit", async () => {
    const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.bin");
    expect(storeUpload(huge, Date.now, DIR)).rejects.toThrow(UploadTooLarge);
  });
});
