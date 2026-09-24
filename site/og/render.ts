/**
 * Render the link-preview card, site/public/og.png, from og.html.
 *
 *   bun run site/og/render.ts
 *
 * A committed PNG rather than an image made per request: the site is static and
 * the card changes only when the headline does. It is served from getshahi.dev
 * like everything else, so no third party renders or hosts it.
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("../", import.meta.url));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    return new Response(Bun.file(site + (path === "/" ? "og/og.html" : path.slice(1))));
  },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL("../public/og.png", import.meta.url)) });
  console.log("Wrote site/public/og.png");
} finally {
  await browser.close();
  server.stop();
}
