import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
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
    expect(response.headers()["cache-control"], asset).toBe("public, no-transform, max-age=31536000, immutable");
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

test("the website serves its own fonts and asks no third party for anything", async ({ page }) => {
  const foreign: string[] = [];
  const refused: string[] = [];
  page.on("request", request => { if (!request.url().startsWith(`${site}/`)) foreign.push(request.url()); });
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

// The homepage offers the web app and the iOS app side by side, and every
// iOS control asks only for an email address, so the owner can send a
// TestFlight invite. Service workers are blocked because one would bypass
// page.route.
test.describe("the homepage's iOS download", () => {
  test.use({ serviceWorkers: "block" });

  test("Download iOS App opens an email dialog that requests a TestFlight invite, and Esc returns focus to it", async ({ page }) => {
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
    const dialog = page.getByRole("dialog", { name: "Download the iOS app" });
    await expect(dialog).toBeVisible();
    const email = dialog.getByRole("textbox", { name: "Email address" });
    await expect(email).toBeFocused();
    await email.fill("tester@example.com");
    // Consent stays required, as the privacy policy describes: without it the
    // browser refuses the form, which the single request below also proves.
    await dialog.getByRole("button", { name: "Email me an invite" }).click();
    await dialog.getByRole("checkbox", { name: "Email me about the Shahi iOS beta." }).check();
    await dialog.getByRole("button", { name: "Email me an invite" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Request sent. We’ll email a TestFlight invite to tester@example.com.");
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
    const sectionButton = page.getByRole("region", { name: /Shahi for iPhone/ }).getByRole("button", { name: "Get a TestFlight invite" });
    await sectionButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(sectionButton).toBeFocused();
    expect(refused).toEqual([]);
  });

  test("the two download choices and the email dialog fit a 320-pixel screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${site}/`);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await page.getByRole("link", { name: "Download iOS App (TestFlight)" }).click();
    const dialog = page.getByRole("dialog", { name: "Download the iOS app" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Email me an invite" })).toBeInViewport();
    expect(await fits()).toBe(true);
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
