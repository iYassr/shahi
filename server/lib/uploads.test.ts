import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR, UploadTooLarge, safeName, storeUpload } from "./uploads";

afterAll(async () => {
  await rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => {});
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
    const stored = await storeUpload(new File(["hello"], "note.txt", { type: "text/plain" }));
    expect(stored.path.startsWith(UPLOAD_DIR)).toBe(true);
    expect(stored.name).toBe("note.txt");
    expect(stored.size).toBe(5);
    expect(await Bun.file(stored.path).text()).toBe("hello");
  });

  // Two photos from a phone are routinely both called IMG_0001.
  test("does not let a second file of the same name overwrite the first", async () => {
    let clock = Date.parse("2026-07-25T10:00:00Z");
    const a = await storeUpload(new File(["one"], "IMG_0001.jpg"), () => clock);
    clock += 1000;
    const b = await storeUpload(new File(["two"], "IMG_0001.jpg"), () => clock);

    expect(a.path).not.toBe(b.path);
    expect(await Bun.file(a.path).text()).toBe("one");
    expect(await Bun.file(b.path).text()).toBe("two");
  });

  test("a traversing name still lands inside the upload directory", async () => {
    const stored = await storeUpload(new File(["x"], "../../../etc/passwd"));
    expect(stored.path.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    expect(stored.path).not.toContain("..");
  });

  test("rejects a file over the limit", async () => {
    const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.bin");
    expect(storeUpload(huge)).rejects.toThrow(UploadTooLarge);
  });
});
