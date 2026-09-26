import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { signup } from "../../site/src/signup";

async function ready(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
}
async function cacheKeys(page: Page) {
  return page.evaluate(async () => (await Promise.all((await caches.keys()).filter(key => key.startsWith("shahi-shell:/pwa/:")).map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
}

test.beforeEach(async ({ request }) => { await request.post("/__hosted/reset"); });
test.afterEach(async ({ request }) => { await request.post("/__hosted/site-online"); await request.post("/__hosted/online"); });

test("Cloudflare serves every public app route with production security headers", async ({ request, page }) => {
  for (const path of ["/pwa/", "/pwa/computers", "/pwa/settings", "/pwa/spaces", "/pwa/space/example", "/pwa/pane/example", "/pwa/notification?pane=example&computer=example"]) {
    const response = await request.get(`http://127.0.0.1:7672${path}`);
    expect(response.status(), path).toBe(200);
    expect(await response.text()).toContain('id="root"');
    expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  }
  expect((await request.get("http://127.0.0.1:7672/pwa/not-a-route")).status()).toBe(404);
  expect((await request.get("http://127.0.0.1:7672/pwa/assets/missing.js")).status()).toBe(404);
  const worker = await request.get("http://127.0.0.1:7672/pwa/sw.js");
  expect(worker.headers()["cache-control"]).toContain("no-store");
  await page.goto("http://127.0.0.1:7672/pwa/");
  await expect(page.getByRole("heading", { name: "Connect your computer" })).toBeVisible();
  await ready(page);
});

// The tests below came from the 2026-09-22 pre-release review. They ask
// wrangler dev rather than the fixture, because the fault in each lived in how
// Cloudflare applies site/public/_headers and serves site/dist, not in the app.
const site = "http://127.0.0.1:7672";

test("a deploy reaches nested app routes because every one revalidates, while hashed assets stay cached for a year", async ({ request }) => {
  // Every route _redirects rewrites to the shell, so a new route is covered here
  // the day it is added. `_headers` matches the requested path, which is how
  // /pwa/pane/* once came back without the no-cache that /pwa/ had.
  const routes = readFileSync(new URL("../../site/public/_redirects", import.meta.url), "utf8").split("\n")
    .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === "/pwa/" && parts[2] === "200")
    .map(parts => parts[0]!.replace(/\*$/, "example"));
  expect(routes.length).toBeGreaterThan(3);
  for (const path of ["/pwa/", ...routes, "/pwa/manifest.webmanifest"]) {
    const cache = (await request.get(`${site}${path}`)).headers()["cache-control"];
    expect(cache, path).toContain("no-cache");
    expect(cache, path).toContain("no-transform");
  }
  const shell = await (await request.get(`${site}/pwa/`)).text();
  const assets = [...shell.matchAll(/\/pwa\/assets\/[^"']+/g)].map(match => match[0]);
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    const response = await request.get(`${site}${asset}`);
    expect(response.status(), asset).toBe(200);
    expect(response.headers()["cache-control"], asset).toBe("public, max-age=31536000, immutable");
  }
});

// no-transform keeps Cloudflare from injecting its beacon into HTML, and also
// stops it compressing anything: production sent every text file whole, the
// app's 548 KB bundle included (measured 2026-09-25). wrangler dev compresses
// regardless, so the header is what can be checked here, not the encoding.
test("HTML keeps no-transform, so nothing is injected, and the rest of the site's text drops it, so the edge compresses it", async ({ request }) => {
  for (const path of ["/", "/privacy", "/no-such-page", "/pwa/"]) {
    expect((await request.get(`${site}${path}`)).headers()["cache-control"], path).toContain("no-transform");
  }
  // The one HTML response without it: a missing file under /pwa/assets/ takes
  // that path's rule, so there the policy is what refuses an injected beacon.
  const missingAsset = await request.get(`${site}/pwa/assets/missing.js`);
  expect(missingAsset.headers()["content-type"]).toContain("text/html");
  expect(missingAsset.headers()["content-security-policy"]).toContain("script-src 'self'");
  // Every text file the build puts beside the pages, so a new one fails here
  // until site/public/_headers names it.
  const dist = new URL("../../site/dist/", import.meta.url);
  const text = (readdirSync(dist, { recursive: true }) as string[])
    .filter(path => /\.(css|js|svg)$/.test(path) && !path.startsWith("pwa/"))
    .map(path => `/${path}`);
  expect(text).toContain("/site.css");
  for (const path of text) {
    const cache = (await request.get(`${site}${path}`)).headers()["cache-control"];
    expect(cache, path).toBe("public, max-age=0, must-revalidate");
  }
});

test("an unknown address shows a Shahi page not found instead of an empty response", async ({ page }) => {
  const refused: string[] = [];
  page.on("console", message => { if (/Content.Security.Policy/i.test(message.text())) refused.push(message.text()); });
  // Outside the app no header rule applies; inside it the app's policy does.
  for (const path of ["/no-such-page", "/pwa/not-a-route"]) {
    const response = await page.goto(`${site}${path}`);
    expect(response!.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), path).toBe("rgb(14, 13, 11)");
  }
  expect(refused).toEqual([]);
});

test("the site's HSTS covers its subdomains, as the relay's does", async ({ request }) => {
  // It lacked the includeSubDomains that relay.getshahi.dev sends (pre-release bug hunt, B51).
  for (const path of ["/", "/privacy", "/pwa/", "/no-such-page"]) {
    expect((await request.get(`${site}${path}`)).headers()["strict-transport-security"], path).toBe("max-age=31536000; includeSubDomains");
  }
});

// The not-found page is itself a file, 404.html, and the assets' html
// handling served it at /404 as an ordinary page, with a 200, and redirected
// /404.html there (pre-release bug hunt, B98).
test("the page-not-found page answers 404 at its own address too, never a soft 200", async ({ page, request }) => {
  for (const path of ["/404", "/404.html"]) {
    const response = await request.get(`${site}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    expect(await response.text(), path).toContain("Page not found.");
    // The same headers as the page served for any other unknown address.
    expect(response.headers()["cache-control"], path).toContain("no-transform");
    expect(response.headers()["x-frame-options"], path).toBe("DENY");
    expect((await page.goto(`${site}${path}`))!.status(), path).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
  }
});

test("an app route typed with a trailing slash reaches the app", async ({ request }) => {
  // _redirects named the exact routes only, so /pwa/settings/ was a 404 (B98).
  const exact = readFileSync(new URL("../../site/public/_redirects", import.meta.url), "utf8").split("\n")
    .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === "/pwa/" && parts[2] === "200" && !parts[0]!.endsWith("*"))
    .map(parts => parts[0]!);
  expect(exact.length).toBeGreaterThan(3);
  for (const path of exact) {
    const response = await request.get(`${site}${path}/`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(301);
    expect(new URL(response.headers()["location"]!, site).pathname, path).toBe(path);
    expect(await (await request.get(`${site}${path}/`)).text(), path).toContain('id="root"');
  }
  // A notification link keeps the pane and computer it names.
  const notification = await request.get(`${site}/pwa/notification/?pane=example&computer=example`, { maxRedirects: 0 });
  expect(new URL(notification.headers()["location"]!, site).search).toBe("?pane=example&computer=example");
});

test("the homepage names the icon an iPhone puts on its home screen", async ({ request }) => {
  // Without one, iOS used a screenshot of the page (B98).
  const home = await request.get(`${site}/`);
  const icon = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(await home.text())?.[1];
  expect(icon).toBeTruthy();
  const response = await request.get(`${site}${icon}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  // An iPhone's home-screen icon is 180 points square: the PNG header says so.
  const png = await response.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
});

test("the website serves its own fonts and asks no third party for anything", async ({ page }) => {
  const foreign: string[] = [];
  const refused: string[] = [];
  // WebKit's native video controls load their own UI from blob: URLs of the
  // page's origin, which never leave the browser (measured once the launch
  // video was on the page, with nothing played).
  page.on("request", request => { if (!request.url().replace(/^blob:/, "").startsWith(`${site}/`)) foreign.push(request.url()); });
  page.on("console", message => { if (/Content.Security.Policy/i.test(message.text())) refused.push(message.text()); });
  const faces = () => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter(face => face.status === "loaded").map(face => `${face.family.replace(/["']/g, "")} ${face.weight}`);
  });
  for (const [path, face] of [["/", "IBM Plex Sans 500"], ["/privacy", "IBM Plex Mono 400"], ["/no-such-page", "IBM Plex Sans 400"]] as const) {
    await page.goto(`${site}${path}`);
    await expect.poll(faces, { message: path }).toEqual(expect.arrayContaining(["IBM Plex Sans 400", face]));
  }
  expect(foreign).toEqual([]);
  expect(refused).toEqual([]);
});

// The launch video comes from R2 through the Worker (site/src/media.ts), not
// from static assets, which answer Range with the whole file: Chrome then
// cannot seek, and WebKit, which opens every video with a bytes=0-1 probe,
// downloads all of it. The bytes here are seed-media.ts's small stand-ins,
// stored under the names site/media.json gives the real files.
test("the launch video is served in byte ranges from the site itself", async ({ page, request }) => {
  await page.goto(`${site}/`);
  const video = page.locator(".launch-video video");
  const named = await video.evaluate((v: HTMLVideoElement) => [v.poster, ...[...v.querySelectorAll("source, track")].map(e => (e as HTMLSourceElement).src)]
    .map(url => new URL(url).pathname));
  const { files } = JSON.parse(readFileSync(new URL("../../site/media.json", import.meta.url), "utf8")) as { files: { name: string; contentType: string }[] };
  expect(named.sort()).toEqual(files.map(file => `/media/${file.name}`).sort());

  for (const { name, contentType } of files) {
    const url = `${site}/media/${name}`;
    const whole = await request.get(url);
    const body = await whole.body();
    expect(whole.status(), name).toBe(200);
    expect(whole.headers(), name).toMatchObject({
      "content-type": contentType, "content-length": String(body.length), "accept-ranges": "bytes",
      // Named after their content, so a year is safe; a Worker's response gets nothing from _headers.
      "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
    });
    const probe = await request.get(url, { headers: { Range: "bytes=0-1" } });
    expect(probe.status(), name).toBe(206);
    expect(probe.headers(), name).toMatchObject({ "content-type": contentType, "content-range": `bytes 0-1/${body.length}` });
    expect(await probe.body(), name).toEqual(body.subarray(0, 2));
    // A seek asks for everything from a point.
    const seek = await request.get(url, { headers: { Range: `bytes=${body.length - 100}-` } });
    expect(seek.status(), name).toBe(206);
    expect(await seek.body(), name).toEqual(body.subarray(body.length - 100));
    const past = await request.get(url, { headers: { Range: `bytes=${body.length}-` } });
    expect(past.status(), name).toBe(416);
    expect(past.headers()["content-range"], name).toBe(`bytes */${body.length}`);
    expect((await request.get(url, { headers: { "If-None-Match": whole.headers()["etag"]! } })).status(), name).toBe(304);
    // An entity tag the R2 binding cannot parse made it throw: a 500 without
    // a range, and a false 416 with one.
    for (const headers of [{ "If-None-Match": "garbage" }, { "If-None-Match": "garbage", Range: "bytes=0-1" }]) {
      const malformed = await request.get(url, { headers });
      expect(malformed.status(), `${name} ${JSON.stringify(headers)}`).toBe(400);
      expect(malformed.headers()["cache-control"], name).toBe("no-store");
    }
  }
  // The last is past R2's 1,024-byte key limit, where bucket.get() throws.
  for (const path of ["/media/missing.0000000a.mp4", "/media/launch.mp4", "/media/..%2findex.html", `/media/${"a".repeat(2000)}.00000000.mp4`]) {
    const missing = await request.get(`${site}${path}`);
    expect(missing.status(), path).toBe(404);
    expect(missing.headers()["cache-control"], path).toBe("no-store");
  }
});

// Chromium only. Neither of Playwright's WebKit builds plays media the way
// Safari does, measured on 26 September 2026:
// - On macOS, "playing" fires but currentTime stays at 0 for five seconds
//   with the whole clip buffered, so a seek never reaches "seeked".
// - On Linux, the GStreamer player opens the first source when the page
//   loads, despite preload="none", and Playwright reports that request with
//   status 0 and no body.
// This half failed on every push from a675787 on, which turned CI red for
// reasons that say nothing about Safari. WebKit still runs the byte-range
// test above, which is what its bytes=0-1 probe depends on.
test("the launch video plays and seeks under the page's policy", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit builds cannot play media (see above)");
  const refused: string[] = [];
  page.on("console", message => { if (/Content.Security.Policy/i.test(message.text())) refused.push(message.text()); });
  const played: number[] = [];
  page.on("response", response => { if (response.url().endsWith(".mp4")) played.push(response.status()); });
  await page.goto(`${site}/`);
  const video = page.locator(".launch-video video");
  await expect(video).toBeVisible();
  // Nothing but the poster loads until the visitor presses play.
  expect(played).toEqual([]);
  // Playwright's linux-arm64 Chromium has no H.264 or AAC, and a video it
  // cannot play left the steps below waiting until the test's timeout.
  expect(await video.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"')),
    "this browser build cannot play H.264 with AAC").not.toBe("");
  // A click in the middle of the frame plays it, with sound. Chrome's own
  // frame does nothing on a click with preload="none"; launch.js's button does.
  // Instant: the page scrolls smoothly, and a box read mid-scroll misses.
  await video.evaluate((v: HTMLVideoElement) => v.scrollIntoView({ block: "center", behavior: "instant" }));
  const frame = (await video.boundingBox())!;
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => ({ paused: v.paused, muted: v.muted }))).toEqual({ paused: false, muted: false });
  await expect(page.locator(".launch-play")).toHaveCount(0);
  // Then seek while paused, so playback cannot carry it there. Each wait is
  // bounded and says what the element reports, rather than a bare timeout.
  const seeked = await video.evaluate(async (v: HTMLVideoElement) => {
    const within = <T,>(step: string, promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() =>
      reject(new Error(`${step} took over 10s: networkState ${v.networkState}, error ${v.error?.code}, source ${v.currentSrc}`)), 10000))]);
    await within("play", v.play());
    v.pause();
    const done = new Promise(resolve => v.addEventListener("seeked", resolve, { once: true }));
    v.currentTime = 1.5;
    await within("seek", done);
    return { at: v.currentTime, seekable: v.seekable.length > 0 ? v.seekable.end(0) : 0 };
  });
  expect(seeked.at).toBeCloseTo(1.5, 1);
  expect(seeked.seekable).toBeGreaterThan(1.9);
  // The two-second stand-in is buffered whole, and then seeks even from a
  // server without ranges, so what proves them is what the browser was sent:
  // Chromium asks for bytes=0-.
  expect(played.length).toBeGreaterThan(0);
  expect(played.every(status => status === 206), played.join(" ")).toBe(true);
  // Captions are off until chosen, so nothing has fetched them yet: choose them.
  await video.evaluate((v: HTMLVideoElement) => { v.textTracks[0]!.mode = "showing"; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.textTracks[0]!.cues?.length ?? 0)).toBeGreaterThan(0);
  expect(refused).toEqual([]);
});

// The homepage offers the web app and the iOS app side by side, and every
// iOS control asks only for an email address, so the owner can send a
// TestFlight invite. Service workers are blocked because one would bypass
// page.route.
test.describe("the homepage's iOS download", () => {
  test.use({ serviceWorkers: "block" });

  test("Download iOS App opens an email dialog that requests a TestFlight invite, keeps focus through sending, and Esc returns focus to it", async ({ page }) => {
    const refused: string[] = [];
    page.on("console", message => { if (/Content.Security.Policy/i.test(message.text())) refused.push(message.text()); });
    // The Worker's own handler answers, with the rate limit open and delivery
    // recorded: the page's request meets the real validation, and no email
    // can leave. The Origin is supplied because an intercepted request does
    // not reliably show the one the browser sends, and the page is
    // same-origin by construction.
    const bodies: unknown[] = [];
    const delivered: string[] = [];
    await page.route(`${site}/api/ios-beta`, async route => {
      const request = route.request();
      bodies.push(request.postDataJSON());
      const response = await signup(new Request(request.url(), {
        method: request.method(), body: request.postData() ?? "",
        headers: { "Content-Type": request.headers()["content-type"] ?? "", Origin: site },
      }), { limit: async () => true, send: async email => { delivered.push(email); } });
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
    });

    await page.goto(`${site}/`);
    await expect(page.getByRole("banner").getByRole("link", { name: "Open Shahi Web App" })).toHaveAttribute("href", "/pwa/");
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Open Shahi Web App" })).toHaveAttribute("href", "/pwa/");
    const download = main.getByRole("link", { name: "Download iOS App (TestFlight)" });
    await download.click();
    const dialog = page.getByRole("dialog", { name: "Request a TestFlight invite" });
    await expect(dialog).toBeVisible();
    const email = dialog.getByRole("textbox", { name: "Email address" });
    await expect(email).toBeFocused();
    await email.fill("tester@example.com");
    // Consent stays required, as the privacy policy describes: without it the
    // browser refuses the form, which the single request below also proves.
    const submit = dialog.getByRole("button", { name: "Email me an invite" });
    await submit.click();
    await dialog.getByRole("checkbox", { name: "Email me my TestFlight invite and beta updates." }).check();
    // From the keyboard: a disabled button used to hand focus to <body>, outside the modal.
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toHaveText("Request sent. We’ll email tester@example.com when your TestFlight invite is ready.");
    await expect(submit).toBeFocused();
    expect(bodies).toEqual([{ email: "tester@example.com", website: "", consent: true }]);
    expect(delivered).toEqual(["tester@example.com"]);
    await expect(email).toHaveValue("");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(download).toBeFocused();
    // The availability line and the beta section open the same dialog, and
    // Esc or its Close button returns focus to whichever opened it.
    const join = main.getByRole("link", { name: "Join the iOS beta" });
    await join.click();
    await expect(dialog).toBeVisible();
    await expect(email).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(join).toBeFocused();
    const sectionButton = page.getByRole("region", { name: /Shahi for iPhone/ }).getByRole("button", { name: "Request a TestFlight invite" });
    await sectionButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(sectionButton).toBeFocused();
    expect(refused).toEqual([]);
  });

  // The status was cleared only when a valid form went out, so reopening the
  // dialog showed the last error, or "we'll email <the previous address>"
  // above an empty form, and an HTML error page from the edge read as
  // "Couldn't reach Shahi" (pre-release bug hunt, B97).
  test("the TestFlight dialog's answer is about the request in front of you, and a server that answered is not called unreachable", async ({ page }) => {
    let answer: "handler" | "html" | "offline" = "handler";
    await page.route(`${site}/api/ios-beta`, async route => {
      if (answer === "offline") return route.abort("internetdisconnected");
      if (answer === "html") return route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
      const request = route.request();
      const response = await signup(new Request(request.url(), {
        method: "POST", body: request.postData() ?? "", headers: { "Content-Type": request.headers()["content-type"] ?? "", Origin: site },
      }), { limit: async () => true, send: async () => {} });
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
    });
    await page.goto(`${site}/`);
    const download = page.getByRole("main").getByRole("link", { name: "Download iOS App (TestFlight)" });
    const dialog = page.getByRole("dialog", { name: "Request a TestFlight invite" });
    const email = dialog.getByRole("textbox", { name: "Email address" });
    const consent = dialog.getByRole("checkbox", { name: "Email me my TestFlight invite and beta updates." });
    const submit = dialog.getByRole("button", { name: "Email me an invite" });
    const status = dialog.getByRole("status");

    // The browser takes a@b; the server does not.
    await download.click();
    await email.fill("a@b");
    await consent.check();
    await submit.click();
    await expect(status).toHaveText("Enter a valid email address.");
    // Editing the address is a new request in the making.
    await email.pressSequentially("c");
    await expect(status).toHaveText("");
    await submit.click();
    await expect(status).toHaveText("Enter a valid email address.");
    // So is reopening the dialog.
    await page.keyboard.press("Escape");
    await download.click();
    await expect(status).toHaveText("");

    // A success names the address it was for, and not the next one.
    await email.fill("tester@example.com");
    await submit.click();
    await expect(status).toHaveText(/^Request sent\. We’ll email tester@example\.com/);
    await page.keyboard.press("Escape");
    await download.click();
    await expect(status).toHaveText("");
    // Sending the emptied form again is refused by the browser, beside no stale answer.
    await expect(email).toHaveValue("");
    await email.fill("tester@example.com");
    await consent.check();
    await submit.click();
    await expect(status).toHaveText(/^Request sent\./);
    await submit.click();
    await expect(status).toHaveText("");

    // An error page is an error from Shahi, and only no answer at all is "Couldn't reach".
    answer = "html";
    await email.fill("tester@example.com");
    await consent.check();
    await submit.click();
    await expect(status).toHaveText("Shahi couldn’t take your request (error 502). Please try again, or email support@getshahi.dev.");
    answer = "offline";
    await submit.click();
    await expect(status).toHaveText("Couldn’t reach Shahi. Please try again, or email support@getshahi.dev.");
  });

  test("the two download choices and the email dialog fit a 320-pixel screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${site}/`);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await page.getByRole("link", { name: "Download iOS App (TestFlight)" }).click();
    const dialog = page.getByRole("dialog", { name: "Request a TestFlight invite" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Email me an invite" })).toBeInViewport();
    expect(await fits()).toBe(true);
  });

  test("on a 320 by 568 screen the answer to a TestFlight request scrolls into the dialog's view", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.route(`${site}/api/ios-beta`, route => route.fulfill({ json: { message: "Request sent. We’ll email tester@example.com when your TestFlight invite is ready." } }));
    await page.goto(`${site}/`);
    await page.getByRole("link", { name: "Download iOS App (TestFlight)" }).click();
    const dialog = page.getByRole("dialog", { name: "Request a TestFlight invite" });
    await dialog.getByRole("textbox", { name: "Email address" }).fill("tester@example.com");
    await dialog.getByRole("checkbox", { name: "Email me my TestFlight invite and beta updates." }).check();
    await dialog.getByRole("button", { name: "Email me an invite" }).click();
    const status = dialog.getByRole("status");
    await expect(status).toHaveText(/^Request sent\./);
    // It used to land below the dialog's fold, so nothing visible said the request went through.
    const below = () => page.evaluate(() => document.querySelector("#beta-status")!.getBoundingClientRect().bottom - document.querySelector("#beta-dialog")!.getBoundingClientRect().bottom);
    await expect.poll(below).toBeLessThanOrEqual(0);
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("Download iOS App still reaches the iOS beta section and an address to ask for an invite", async ({ page }) => {
      await page.goto(`${site}/`);
      // force: Playwright's stability check waits on animation frames, which
      // never arrive with scripting off (measured: "element is not stable"
      // until the timeout, in both engines). The click itself is a real one.
      const download = page.getByRole("link", { name: "Download iOS App (TestFlight)" });
      await expect(download).toBeVisible();
      await download.click({ force: true });
      await expect(page).toHaveURL(`${site}/#ios-beta`);
      const section = page.getByRole("region", { name: /Shahi for iPhone/ });
      const address = section.getByRole("link", { name: "support@getshahi.dev" });
      await expect(address).toBeInViewport();
      await expect(address).toHaveAttribute("href", "mailto:support@getshahi.dev?subject=Shahi%20iOS%20beta");
      // Nothing is offered that could not work: the dialog's opener and the dialog stay hidden.
      await expect(section.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeHidden();
    });
  });
});

// The iPhone 14's viewport, which the WebKit project already has. A line added
// to the lede once pushed the primary button to 619-669 here.
test("on a 390 by 664 phone screen both of the hero's buttons are on the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto(`${site}/`);
  await page.evaluate(() => document.fonts.ready);
  const hero = page.locator(".hero");
  for (const name of ["Open Shahi Web App", "Download iOS App (TestFlight)"]) {
    // Polled: the hero settles 6px upward as it arrives.
    const bottom = () => hero.getByRole("link", { name }).evaluate(link => link.getBoundingClientRect().bottom - innerHeight);
    await expect.poll(bottom, { message: name }).toBeLessThanOrEqual(0);
  }
});

test("fresh users can find setup and installation help without horizontal overflow", async ({ page }) => {
  await page.goto("/pwa/");
  await expect(page.getByRole("heading", { name: "Set up Shahi in 3 steps" })).toBeVisible();
  await expect(page.getByText("herdr plugin install iYassr/shahi", { exact: true })).toBeVisible();
  await expect(page.getByText("herdr plugin action invoke shahi.pair", { exact: true })).toBeVisible();
  await page.getByText("Install Shahi on this device", { exact: true }).click();
  await expect(page.getByText(/open the browser’s Share menu/)).toBeVisible();
  await expect(page.getByLabel("Remember this browser")).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("offline shell includes all installation assets and survives computers and notification navigation", async ({ page, request }) => {
  await page.goto("/pwa/");
  await ready(page);
  const initial = await cacheKeys(page);
  for (const name of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png", "welcome.js"]) expect(initial.some(url => url.endsWith(`/pwa/${name}`))).toBe(true);
  await request.post("/__hosted/site-offline");
  for (const path of ["/pwa/computers", "/pwa/notification?pane=private-pane&computer=private-computer"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  }
  const assets = await page.evaluate(async () => Promise.all(["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"].map(async name => {
    const response = await fetch(`/pwa/${name}`);
    return { ok: response.ok, size: (await response.arrayBuffer()).byteLength };
  })));
  expect(assets.every(asset => asset.ok && asset.size > 100)).toBe(true);
  const keys = await cacheKeys(page);
  expect(keys.every(value => !new URL(value).search && !/private-|\/api\/|\/notification|\/computers/.test(value))).toBe(true);
  expect(keys.some(value => new URL(value).pathname === "/pwa/")).toBe(true);
});

test("remembered access survives cached cold launches and repeated relay recovery", async ({ page, request }) => {
  const { code } = await (await request.post("/__hosted/reset")).json();
  await page.goto("/pwa/");
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head:visible, .agent-sidebar__request:visible").first()).toBeVisible();
  await ready(page);
  for (let n = 0; n < 3; n++) {
    await request.post("/__hosted/offline");
    await request.post("/__hosted/site-offline");
    await page.reload();
    await expect(page.locator(".connection-health")).toBeVisible();
    await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
    await request.post("/__hosted/site-online");
    await request.post("/__hosted/online");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await (await request.get("/__hosted/connections")).json()).live).toBe(1);
    await expect(page.locator(".blocked__head:visible, .agent-sidebar__request:visible").first()).toBeVisible();
    await expect(page.locator(".connection-health")).toHaveCount(0);
  }
  expect((await (await request.get("/__hosted/device-count")).json()).count).toBe(1);
  expect((await (await request.get("/__hosted/writes")).json()).writes).toHaveLength(0);
  expect((await cacheKeys(page)).every(value => !new URL(value).search && !value.includes("/api/"))).toBe(true);
});

test("an interrupted worker update retains the previous complete offline app", async ({ page, request }) => {
  await page.goto("/pwa/");
  await ready(page);
  await request.post("/__hosted/broken-worker");
  const result = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const previous = registration.active;
    const outcome = new Promise<string>(resolve => registration.addEventListener("updatefound", () => {
      const installing = registration.installing!;
      installing.addEventListener("statechange", () => {
        if (installing.state === "redundant" || installing.state === "activated") resolve(installing.state);
      });
    }, { once: true }));
    await registration.update();
    return { state: await outcome, retained: registration.active === previous };
  });
  expect(result).toEqual({ state: "redundant", retained: true });
  await request.post("/__hosted/site-offline");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect your computer" })).toBeVisible();
});

test("a page whose release has left the server still opens the terminal", async ({ page, request }) => {
  // A deploy removes the previous release's files. Lazily loaded chunks were
  // cached only once something had opened them, so a page left open across a
  // deploy could not open the terminal at all, and the error screen's ways out
  // forgot this session-only computer.
  const { code } = await (await request.post("/__hosted/reset")).json();
  await page.goto("/pwa/");
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head:visible, .agent-sidebar__request:visible").first()).toBeVisible();
  await ready(page);
  await request.post("/__hosted/site-offline");
  await page.locator(".blocked__head:visible, .agent-sidebar__request:visible").first().click();
  await page.getByRole("tab", { name: "Screen", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
});

test("the app opens with the browser network completely offline", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "Playwright WebKit offline navigation fails before invoking its service worker; hosting outages are covered in both engines above.");
  await page.goto("/pwa/");
  await ready(page);
  await context.setOffline(true);
  try {
    await page.goto("/pwa/");
    await expect(page.getByRole("heading", { name: "Connect your computer" })).toBeVisible();
    await page.goto("/pwa/computers");
    await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  } finally { await context.setOffline(false); }
});
