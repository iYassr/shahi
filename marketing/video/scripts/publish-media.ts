// Publishes the launch cut to the website: web encodes of the masters in out/,
// a poster and the captions, each named after its content, into out/media/;
// then site/media.json and the four /media/ URLs in site/public/index.html;
// then, with --local or --remote, the files into the R2 bucket the site
// Worker serves /media/ from (site/src/media.ts).
//
//   bun marketing/video/scripts/publish-media.ts            → out/media/, site/media.json, index.html
//   bun marketing/video/scripts/publish-media.ts --local    … and wrangler dev's local R2
//   bun marketing/video/scripts/publish-media.ts --remote   … and the real bucket; deploy the site after
//
// The masters (`bun run render:launch`) are CRF 14 for LinkedIn and Reddit,
// which re-encode everything; 9.7 MB is too much to hand a visitor. Rerunning
// on an unchanged cut writes the same bytes, so the names do not change.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINES } from "../audio/voiceover";

const VIDEO = join(import.meta.dirname, "..");
const REPO = join(VIDEO, "../..");
const OUT = join(VIDEO, "out/media");
const WORK = join(OUT, ".work");
const MANIFEST = join(REPO, "site/media.json");
const PAGE = join(REPO, "site/public/index.html");
// The MEDIA binding's bucket in site/wrangler.toml.
const BUCKET = "shahi-site-media";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--local" && arg !== "--remote")) {
  console.error("usage: bun marketing/video/scripts/publish-media.ts [--local | --remote]");
  process.exit(2);
}
const target = args[0]?.slice(2);

function run(command: string, argv: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn(command, argv, { cwd, stdio: "inherit" }).on("error", reject).on("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${argv.join(" ")} failed (${code ?? signal})`)));
  });
}
// The local binary, not npx: npx took 19s to start here, checking the network.
const remotion = (argv: string[]) => run(join(VIDEO, "node_modules/.bin/remotion"), argv, VIDEO);

/**
 * H.264 High and stereo AAC, for the web. CRF 22 keeps the wide cut's dark
 * gradients and grid clean where CRF 26 banded them; the square cut is seen
 * smaller, on phones, so CRF 24. The caps hold the bitrate under a phone's
 * connection through the busiest scenes. The mix is stereo: never -ac 1.
 *
 * One encoder thread, because x264's rate control under a cap depends on
 * thread timing: two runs of the same cut differed by 2 KB, so every rerun
 * would have been a new name and a new upload. One thread gave the same bytes
 * twice, in 47s for the wide cut, and the two cuts are encoded side by side.
 *
 * +faststart puts the index first; a plain ffmpeg encode puts it last, and a
 * browser then needs a second request, to the end of the file, before it can
 * start playing.
 */
async function encode(master: string, output: string, crf: number, maxrate: string, bufsize: string) {
  await remotion(["ffmpeg", "-v", "error", "-y", "-i", master, "-threads", "1",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-maxrate", maxrate, "-bufsize", bufsize,
    "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-g", "60",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
    "-movflags", "+faststart", output]);
  if (!indexFirst(readFileSync(output))) throw new Error(`${output} does not start with its index (moov)`);
}

/** Whether an MP4's index (moov) comes before its media (mdat), walking the top-level boxes. */
function indexFirst(bytes: Buffer): boolean {
  for (let at = 0; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "moov") return true;
    if (type === "mdat" || size < 8) return false;
    at += size;
  }
  return false;
}

const WIDE = join(VIDEO, "out/shahi-launch-16x9.mp4");
const SQUARE = join(VIDEO, "out/shahi-launch-1x1.mp4");
const CAPTIONS = join(VIDEO, "out/shahi-launch.en.vtt");

type Media = { stem: string; ext: string; contentType: string; make: (output: string) => Promise<void> };
const MEDIA: Media[] = [
  { stem: "launch-16x9", ext: "mp4", contentType: "video/mp4",
    make: (output) => encode(WIDE, output, 22, "2M", "4M") },
  { stem: "launch-1x1", ext: "mp4", contentType: "video/mp4",
    make: (output) => encode(SQUARE, output, 24, "1.5M", "3M") },
  // One poster for both players (src/launch/Poster.tsx says why). JPEG,
  // because this ffmpeg has no WebP encoder; quality 90 is about 55 KB.
  { stem: "launch-poster", ext: "jpg", contentType: "image/jpeg",
    make: (output) => remotion(["still", "LaunchPoster", output, "--image-format=jpeg", "--jpeg-quality=90", "--log=error"]) },
  // Written beside the masters by `bun run sound`, from the voice-over's lines.
  { stem: "launch", ext: "en.vtt", contentType: "text/vtt; charset=utf-8",
    make: async (output) => copyFileSync(CAPTIONS, output) },
];

// The page's /media/ URL for a file of this stem, whatever its hash.
const urlOf = (media: Media) => new RegExp(`/media/${media.stem}\\.[0-9a-f]{8}\\.${media.ext.replace(".", "\\.")}(?=")`, "g");

// Everything that can be checked is checked before anything is deleted or
// started: checked later, a missing master failed one encode while the other
// ran on as an orphan, and a page that failed its check after the manifest
// was written left the two out of step.
const missing = [WIDE, SQUARE, CAPTIONS].filter((file) => !existsSync(file));
if (missing.length > 0) throw new Error(`${missing.join(", ")} missing: run \`bun run render:launch\` first`);
const original = readFileSync(PAGE, "utf8");
for (const media of MEDIA) {
  const found = original.match(urlOf(media))?.length ?? 0;
  if (found !== 1) throw new Error(`site/public/index.html names /media/${media.stem}.<hash>.${media.ext} ${found} times, not once`);
}
// The page's transcript is a copy of the voice-over's words, typeset.
const untranscribed = LINES.filter((line) => !original.includes(line.text.replaceAll("'", "’")));
if (untranscribed.length > 0) {
  throw new Error(`the transcript in site/public/index.html lacks: ${untranscribed.map((line) => `"${line.text}"`).join(", ")}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const files = await Promise.all(MEDIA.map(async (media) => {
  const scratch = join(WORK, `${media.stem}.${media.ext}`);
  await media.make(scratch);
  const bytes = readFileSync(scratch);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ...media, name: `${media.stem}.${sha256.slice(0, 8)}.${media.ext}`, scratch, bytes: bytes.length, sha256 };
}));
for (const file of files) {
  renameSync(file.scratch, join(OUT, file.name));
  console.log(`${file.name}  ${(file.bytes / 1e6).toFixed(2)} MB`);
}
rmSync(WORK, { recursive: true, force: true });

// The page is rewritten and checked before either file is written, so the two
// are written together or not at all.
const page = files.reduce((text, file) => text.replace(urlOf(file), `/media/${file.name}`), original);
for (const file of files) {
  if (page.split(`/media/${file.name}"`).length !== 2) throw new Error(`the rewritten page does not name /media/${file.name} once`);
}
const manifest = JSON.stringify({
  "//": "Written by marketing/video/scripts/publish-media.ts. The files are in the R2 bucket shahi-site-media, not in git; docs/browser-hosting.md says how to publish a new cut.",
  files: files.map(({ name, contentType, bytes, sha256 }) => ({ name, contentType, bytes, sha256 })),
}, null, 2) + "\n";
writeFileSync(MANIFEST, manifest);
writeFileSync(PAGE, page);
console.log("Wrote site/media.json and the /media/ URLs in site/public/index.html.");

if (target) {
  // --config puts a local object where `wrangler dev --config
  // site/wrangler.toml` reads it: site/.wrangler/state, beside the config.
  for (const file of files) {
    await run(join(REPO, "node_modules/.bin/wrangler"), ["r2", "object", "put", `${BUCKET}/${file.name}`,
      "--file", join(OUT, file.name), "--content-type", file.contentType, `--${target}`,
      "--config", "site/wrangler.toml"], REPO);
  }
  console.log(target === "remote"
    ? `Uploaded to ${BUCKET}. Deploy the site next (docs/browser-hosting.md), so the page names these files.`
    : "Stored in local R2 for `bunx wrangler dev --config site/wrangler.toml`.");
}
