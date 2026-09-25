/**
 * Fills wrangler dev's local R2 for the PWA suite with small stand-ins for the
 * launch video, stored under the names site/media.json gives the real files.
 * The real ones live in R2, not git, so CI has none; the suite checks how the
 * site serves /media/ (site/src/media.ts), which any bytes show. pwa.config.ts
 * runs this with the directory it then hands `wrangler dev --persist-to`, so a
 * run never touches the local R2 that `publish-media.ts --local` filled.
 *
 *   bun e2e/hosted/seed-media.ts <persist directory>
 *
 * e2e/hosted/media/ was cut once from the launch cut with Remotion's ffmpeg,
 * run from marketing/video:
 *   remotion ffmpeg -ss 1 -t 2 -i out/shahi-launch-16x9.mp4 -vf scale=320:180 -threads 1 -c:v libx264 -preset slow
 *     -crf 30 -profile:v high -pix_fmt yuv420p -g 30 -c:a aac -b:a 64k -ac 2 -ar 48000 -movflags +faststart
 *     -map_metadata -1 launch.mp4
 *   remotion ffmpeg -i out/media/launch-poster.<hash>.jpg -vf scale=96:96 -q:v 5 -map_metadata -1 poster.jpg
 */
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv[2]) throw new Error("usage: bun e2e/hosted/seed-media.ts <persist directory>");
const persist = resolve(process.argv[2]);
const root = fileURLToPath(new URL("../../", import.meta.url));
const { files } = JSON.parse(readFileSync(new URL("../../site/media.json", import.meta.url), "utf8")) as { files: { name: string; contentType: string }[] };
const standIn = (name: string) => name.endsWith(".mp4") ? "launch.mp4" : name.endsWith(".jpg") ? "poster.jpg" : "launch.en.vtt";

rmSync(persist, { recursive: true, force: true });
// One at a time: each put is a separate miniflare writing the same SQLite files.
for (const file of files) {
  const put = Bun.spawnSync(["bunx", "wrangler", "r2", "object", "put", `shahi-site-media/${file.name}`,
    "--file", `e2e/hosted/media/${standIn(file.name)}`, "--content-type", file.contentType,
    "--local", "--persist-to", persist, "--config", "site/wrangler.toml"], { cwd: root });
  if (put.exitCode !== 0) throw new Error(`seeding ${file.name} failed:\n${put.stdout}${put.stderr}`);
}
console.log(`Seeded ${files.length} stand-in media files into ${persist}.`);
