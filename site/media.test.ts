import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MEDIA_NAME, mediaType } from "./src/media";

// The files themselves are in R2, not git (site/src/media.ts says why), so
// these check the committed manifest that publish-media.ts writes beside the
// page, and the page against it.
type File = { name: string; contentType: string; bytes: number; sha256: string };
const { files } = JSON.parse(readFileSync(new URL("./media.json", import.meta.url), "utf8")) as { files: File[] };

test("every media file is named after its content, so a year of immutable caching is safe", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(file.sha256, file.name).toMatch(/^[0-9a-f]{64}$/);
    expect(file.name).toMatch(MEDIA_NAME);
    expect(file.name.split(".")[1], file.name).toBe(file.sha256.slice(0, 8));
    // What the Worker will send for the name is what the file was uploaded as.
    expect(mediaType(file.name), file.name).toBe(file.contentType);
  }
});

test("each video is small enough for a phone to start on a slow connection", () => {
  // The CRF 14 masters, made for social sites that re-encode, were 9.7 and 6.7 MB.
  for (const file of files.filter(file => file.name.endsWith(".mp4"))) expect(file.bytes, file.name).toBeLessThan(5 * 1024 * 1024);
});

test("the homepage names exactly the published files", () => {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const named = [...html.matchAll(/["']\/media\/([^"']+)["']/g)].map(match => match[1]);
  expect(named.sort()).toEqual(files.map(file => file.name).sort());
});
