/**
 * App Store screenshots: a headline over a framed simulator capture, at the
 * 6.9-inch size (1320 × 2868) App Store Connect asks for.
 *
 *   bun marketing/app-store/render.ts <captures dir> <out dir>
 *
 * The captures come from the Release app on an iPhone 17 Pro Max simulator,
 * paired with the stub's "showcase" scenario (e2e/stub/showcase.ts): invented
 * projects and agents, never a real session. frames.json says which capture
 * goes with which words. Brand colours and IBM Plex come from the site.
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [captures, out] = process.argv.slice(2).map((p) => resolve(p!));
if (!captures || !out) throw new Error("usage: render.ts <captures dir> <out dir>");
const here = import.meta.dir;
const fonts = resolve(here, "../../site/public/fonts");
const frames = JSON.parse(readFileSync(join(here, "frames.json"), "utf8")) as { file: string; capture: string; title: [string, string]; sub: string }[];
const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
// Embedded: a page set from a string cannot fetch file:// fonts, and silently
// fell back to the system face.
const face = (weight: number, file: string) =>
  `@font-face { font-family: Plex; font-weight: ${weight}; src: url("data:font/woff2;base64,${readFileSync(join(fonts, file)).toString("base64")}") format("woff2"); }`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 2868 }, deviceScaleFactor: 1 });
for (const frame of frames) {
  await page.setContent(`<!doctype html><html><head><style>
    ${face(400, "IBMPlexSans-Regular-Latin1.woff2")} ${face(600, "IBMPlexSans-SemiBold-Latin1.woff2")}
    * { box-sizing: border-box; margin: 0; }
    body { width: 1320px; height: 2868px; overflow: hidden; font-family: Plex, sans-serif; color: #F0EFEA;
      background: radial-gradient(1200px 900px at 50% 0%, #2a2015 0%, #0E0D0B 70%); }
    header { padding: 150px 90px 0; text-align: center; }
    h1 { font-weight: 600; font-size: 112px; line-height: 1.06; letter-spacing: -0.025em; }
    h1 span { display: block; color: #E8A33D; }
    p { margin-top: 36px; font-size: 46px; line-height: 1.32; color: #A6A099; }
    .phone { position: absolute; left: 50%; top: 690px; transform: translateX(-50%); width: 940px; padding: 18px;
      border-radius: 140px; background: #1c1a17; box-shadow: 0 0 0 3px #3A352C, 0 60px 140px rgba(0,0,0,.65); }
    .phone img { display: block; width: 100%; border-radius: 122px; }
  </style></head><body>
    <header><h1>${frame.title[0]}<span>${frame.title[1]}</span></h1><p>${frame.sub}</p></header>
    <div class="phone"><img src="${dataUrl(join(captures, frame.capture))}"></div>
  </body></html>`);
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.evaluate(() => document.fonts.check('600 112px Plex')))) throw new Error("IBM Plex did not load");
  await page.screenshot({ path: join(out, frame.file), type: "png" });
  console.log(frame.file);
}
await browser.close();
