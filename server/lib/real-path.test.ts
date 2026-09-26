/**
 * Bun's `realpath` reads a backslash in the path it is given as a separator,
 * so a legal macOS or Linux file name with one in it could not be opened or
 * listed, and `a\b.txt` resolved to `a/b.txt` (pre-release bug hunt,
 * September 2026). `realPath` walks such a path itself; these are the cases
 * the walk has to get right, each against the answer `realpath` gives in Node.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath, realPathSync } from "./real-path";

// Made through the temp directory as spelt, which on macOS is itself behind a
// symlink (/var -> /private/var), so every walk below follows one link first.
const spelt = mkdtempSync(join(tmpdir(), "shahi-real-path-"));
const real = realpathSync(spelt);
afterAll(() => rmSync(spelt, { recursive: true, force: true }));

mkdirSync(join(spelt, "a"));
writeFileSync(join(spelt, "a", "b.txt"), "slash");
writeFileSync(join(spelt, "a\\b.txt"), "backslash");
writeFileSync(join(spelt, 'we"ird\\name.txt'), "quoted");
mkdirSync(join(spelt, "proj\\one"));
writeFileSync(join(spelt, "proj\\one", "in.txt"), "inside");
mkdirSync(join(spelt, "sub\\dir"));
symlinkSync("proj\\one", join(spelt, "link\\relative"));
symlinkSync(join(real, "a\\b.txt"), join(spelt, "link\\absolute"));
symlinkSync("../a\\b.txt", join(spelt, "sub\\dir", "up"));
symlinkSync("link\\relative", join(spelt, "link\\chained"));
symlinkSync("loop\\2", join(spelt, "loop\\1"));
symlinkSync("loop\\1", join(spelt, "loop\\2"));

const both = [
  ["realPath", realPath],
  ["realPathSync", async (path: string) => realPathSync(path)],
] as const;

describe.each(both)("%s", (_, resolveReal) => {
  test("a name with a backslash is itself, not the path its halves would spell", async () => {
    expect(await resolveReal(join(spelt, "a\\b.txt"))).toBe(join(real, "a\\b.txt"));
    expect(await resolveReal(join(spelt, 'we"ird\\name.txt'))).toBe(join(real, 'we"ird\\name.txt'));
    expect(await resolveReal(join(spelt, "proj\\one"))).toBe(join(real, "proj\\one"));
    expect(await resolveReal(join(spelt, "proj\\one", "in.txt"))).toBe(join(real, "proj\\one", "in.txt"));
  });

  test("links are followed, relative to the link's real directory or from the root", async () => {
    expect(await resolveReal(join(spelt, "link\\relative", "in.txt"))).toBe(join(real, "proj\\one", "in.txt"));
    expect(await resolveReal(join(spelt, "link\\absolute"))).toBe(join(real, "a\\b.txt"));
    expect(await resolveReal(join(spelt, "sub\\dir", "up"))).toBe(join(real, "a\\b.txt"));
    expect(await resolveReal(join(spelt, "link\\chained"))).toBe(join(real, "proj\\one"));
  });

  test("dots in the path as written fold before anything is followed, as realpath does", async () => {
    expect(await resolveReal(join(spelt, "proj\\one", ".", "..", "a\\b.txt"))).toBe(join(real, "a\\b.txt"));
  });

  test("a path that names nothing is refused as realpath refuses it", async () => {
    await expect(resolveReal(join(spelt, "absent\\file"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveReal(join(spelt, "a\\b.txt", "more"))).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(resolveReal(join(spelt, "loop\\1"))).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("a path without a backslash is realpath's answer", async () => {
    expect(await resolveReal(join(spelt, "a", "b.txt"))).toBe(join(real, "a", "b.txt"));
  });
});
