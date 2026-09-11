import { test, expect, type Page } from "@playwright/test";

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

test("fresh users can find setup and installation help without horizontal overflow", async ({ page }) => {
  await page.goto("/pwa/");
  await page.getByText("Set up your computer", { exact: true }).click();
  await expect(page.getByText("herdr plugin install iYassr/shahi", { exact: true })).toBeVisible();
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
  await expect(page.locator(".blocked__head").first()).toBeVisible();
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
    await expect(page.locator(".blocked__head").first()).toBeVisible();
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
