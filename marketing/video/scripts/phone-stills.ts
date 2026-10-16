// Renders the phone cut's key frames as stills, from one bundle, for review
// without playing the video:
//
//   bun scripts/phone-stills.ts [composition…]          → out/phone-stills/<id>-<frame>-<scene>.png
//   bun scripts/phone-stills.ts PhoneWide --at 405,409   … or just the frames named
//
// Defaults to all three formats. The frames are one per scene, each where its
// point is made, so a change to the timeline moves them with it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { AGENTS, ANSWER, END, HERDR, MORE, PROBLEM, READER, REACH, SETUP, T } from "../src/phone/timeline";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const atFlag = args.indexOf("--at");
const named = atFlag >= 0 ? args.splice(atFlag, 2)[1].split(",").map(Number) : null;
const ids = args.length ? args : ["PhoneWide", "PhoneSquare", "PhoneTall"];
const scenes = {
  problem: PROBLEM.squint + 30,
  reader: READER.scrollAt - 10,
  answer: ANSWER.working + 30,
  agents: AGENTS.names[4].at + 20,
  herdr: HERDR.pick + 40,
  setup: SETUP.chips[3] + 10,
  ssh: T.reach - 40,
  notify: REACH.tapBanner - 6,
  dictate: REACH.wordsAt + 70,
  more: MORE.beats[2] + 20,
  end: END.url + 40,
};
const frames: Record<string, number> = named ? Object.fromEntries(named.map((f) => [`at${f}`, f])) : scenes;

const serveUrl = await bundle({ entryPoint: join(ROOT, "src/index.ts") });
const out = join(ROOT, "out/phone-stills");
mkdirSync(out, { recursive: true });
for (const id of ids) {
  const composition = await selectComposition({ serveUrl, id });
  for (const [name, frame] of Object.entries(frames)) {
    const file = join(out, `${id}-${String(frame).padStart(4, "0")}-${name}.png`);
    await renderStill({ composition, serveUrl, frame, output: file });
    console.log(file);
  }
}
