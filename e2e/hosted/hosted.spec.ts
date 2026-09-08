import { test as base, expect } from "@playwright/test";
import QRCode from "qrcode";
const test = base.extend<{ noPlaintext: void }>({
  noPlaintext: [async ({ context, baseURL }, use) => {
    const leaks: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL || url.pathname.startsWith("/api/")) {
        leaks.push(`${url.origin}${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    await use();
    expect(leaks, "hosted app must send session data only inside encrypted relay frames").toEqual([]);
  }, { auto: true }],
});
let code: string, web: string;
test.beforeEach(async ({ request }) => {
  const reset = await request.post("/__hosted/reset");
  ({ code, web } = await reset.json());
});
async function pair(page: import("@playwright/test").Page, remember = false) {
  await page.goto("/pwa/");
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByLabel("Device name", { exact: true }).fill("Browser test");
  if (remember) await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
}
test("pairs over encrypted relay, submits once, reads history and forgets a memory session", async ({ page, request }) => {
  await pair(page);
  await page.locator(".blocked__head").first().click();
  await page.locator("textarea").fill("encrypted browser fixture prompt");
  await page.locator(".compose__send").click();
  await expect.poll(async () => (await (await request.get("/__hosted/writes")).json()).writes.filter((w: {path:string}) => w.path.endsWith("/prompt")).length).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});
test("remembered pairing restores and explicit signout erases browser identity", async ({ page }) => {
  await pair(page, true);
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Browser test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});
test("revoking this browser clears its remembered connection", async ({ page, request }) => {
  await pair(page, true);
  await request.post("/__hosted/revoke");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});
test("fragment pairing is removed before connecting and no secret is stored in web storage", async ({ page }) => {
  await page.goto(web);
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(code);
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  const values = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(values.includes("deviceSecret")).toBe(false);
  expect(values.includes(new URLSearchParams(code.split("#")[1]).get("secret")!)).toBe(false);
});
test("hosted shell has restrictive security headers and phone/laptop layouts fit", async ({ page }) => {
  const response = await page.goto("/pwa/");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("files, images, downloads and uploads stay inside the encrypted connection", async ({ page, request }) => {
  await pair(page);
  await page.locator(".blocked__head").first().click();
  await expect(page.locator(".reader .msg").first()).toBeVisible();
  const image = page.locator(".msg__image").first();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await page.locator(".tool__open").first().click();
  await expect(page.locator(".viewer__text")).toContainText("OPTION_RE");
  await page.locator(".viewer__close").click();
  const download = page.waitForEvent("download");
  await page.locator(".tool__get").first().click();
  expect((await download).suggestedFilename()).toBe("prompt-parser.ts");
  await page.getByRole("button", { name: "Attach a file", exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("encrypted upload fixture") });
  await expect.poll(async () => (await (await request.get("/__hosted/writes")).json()).requests.some((r: {path:string}) => r.path === "/api/uploads")).toBe(true);
});

test("camera starts only on request and a cancelled pending permission stops its tracks", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { cameraCalls: number; stoppedTracks: number; grantCamera(): void };
    state.cameraCalls = 0; state.stoppedTracks = 0;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: () => { state.cameraCalls++; return new Promise(resolve => {
        state.grantCamera = () => { const stream = new MediaStream(); Object.defineProperty(stream, "getTracks", { value: () => [{ stop: () => { state.stoppedTracks++; } }] }); resolve(stream); };
      }); },
    } });
  });
  await page.goto("/pwa/");
  expect(await page.evaluate(() => (window as unknown as {cameraCalls:number}).cameraCalls)).toBe(0);
  await page.getByRole("button", { name: "Scan QR code", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {cameraCalls:number}).cameraCalls)).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => (window as unknown as {grantCamera():void}).grantCamera());
  await expect.poll(() => page.evaluate(() => (window as unknown as {stoppedTracks:number}).stoppedTracks)).toBe(1);
});

test("camera decodes the plugin QR locally and stops scanning", async ({ page }) => {
  const qr = QRCode.create(code).modules;
  const width = (qr.size + 8) * 3;
  const pixels = new Array<number>(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / 3) - 4, col = Math.floor(x / 3) - 4;
    if (row >= 0 && col >= 0 && row < qr.size && col < qr.size && qr.get(row, col)) {
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  await page.addInitScript(({ width, pixels }) => {
    const state = window as unknown as { stoppedTracks: number };
    state.stoppedTracks = 0;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
      const stream = new MediaStream(); Object.defineProperty(stream, "getTracks", { value: () => [{ stop: () => { state.stoppedTracks++; } }] }); return stream;
    } } });
    Object.defineProperties(HTMLVideoElement.prototype, { videoWidth: { get: () => width }, videoHeight: { get: () => width }, readyState: { get: () => 4 } });
    HTMLMediaElement.prototype.play = async () => {};
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(pixels), width, height: width }) })) as never;
  }, { width, pixels });
  await page.goto("/pwa/");
  await page.getByRole("button", { name: "Scan QR code", exact: true }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(code);
  await expect(page.getByRole("dialog", { name: "Scan pairing QR code" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as {stoppedTracks:number}).stoppedTracks)).toBeGreaterThan(0);
});

test("website notification permission never auto-enrolls a new computer", async ({ page, request }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted", requestPermission: async () => "granted" } }); });
  await pair(page, true);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const before = (await (await request.get("/__hosted/writes")).json()).requests as { path: string }[];
  expect(before.some(item => item.path.startsWith("/api/push/"))).toBe(false);
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect.poll(async () => (await (await request.get("/__hosted/writes")).json()).requests.some((item: {path:string}) => item.path === "/api/push/key")).toBe(true);
});

test("temporary browser access cannot leave background notification access behind", async ({ page }) => {
  await pair(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
});

test("two remembered computers switch both ways, survive reload, and sign out independently", async ({ page, request }) => {
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await pair(page, true);
  async function computers() {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Switch or add a computer", exact: true }).click();
  }
  async function choose(port: string) {
    await page.getByRole("button", { name: new RegExp(`Connect to .*127\\.0\\.0\\.1:${port}`) }).click();
    await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  }
  async function send(text: string) {
    await page.locator(".blocked__head").first().click();
    await page.locator("textarea").fill(text);
    await page.locator(".compose__send").click();
    await page.getByRole("button", { name: /back/i }).first().click();
  }
  await computers();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  await computers(); await choose("7472");
  await send("computer-a-only");
  await computers(); await choose("7572");
  await send("computer-b-only");
  await page.reload();
  await computers();
  await expect(page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7572/ })).toHaveText("Current computer");
  await choose("7472");
  const a = await (await request.get("/__hosted/writes")).json();
  const b = await (await request.get("http://127.0.0.1:7572/__hosted/writes")).json();
  expect(a.writes.filter((w: any) => w.path.endsWith("/prompt")).map((w: any) => w.body.text)).toEqual(["computer-a-only"]);
  expect(b.writes.filter((w: any) => w.path.endsWith("/prompt")).map((w: any) => w.body.text)).toEqual(["computer-b-only"]);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ })).toHaveCount(0);
  await choose("7572");
});

test("a temporary second computer does not replace the remembered first computer", async ({ page, request }) => {
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await pair(page, true);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Switch or add a computer", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7572/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
});

test("an offline or revoked computer never hides the other saved computers", async ({ page, request }) => {
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await pair(page, true);
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await request.post("http://127.0.0.1:7572/__hosted/offline");
  await expect(page.getByText("Computer disconnected", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Switch computer", { exact: true })).toBeVisible();
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await expect(page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7572/ })).toBeVisible();
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await request.post("http://127.0.0.1:7572/__hosted/online");
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7572/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await request.post("http://127.0.0.1:7572/__hosted/revoke");
  await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
});

test("an update cannot silently reload away another temporary computer", async ({ page, request }) => {
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await pair(page, true);
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await page.route("**/pwa/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/\/pwa\/assets\/[^"']+\.js/, "/pwa/assets/synthetic-new-release.js");
    await route.fulfill({ response, body });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect(page.getByText(/Reloading forgets computers/)).toBeVisible();
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7572/ }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
});

test("both computers remain live through quick switches and revoking one leaves the other usable", async ({ page, request }) => {
  await pair(page, true);
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ New agent", exact: true })).toBeVisible();
  const counts = async (port: number) => (await (await request.get(`http://127.0.0.1:${port}/__hosted/connections`)).json());
  await expect.poll(async () => (await counts(7472)).live).toBe(1);
  await expect.poll(async () => (await counts(7572)).live).toBe(1);
  for (const port of [7472, 7572, 7472]) {
    await page.getByLabel("Switch computer", { exact: true }).click();
    // Both fixtures deliberately share a machine name; order follows pairing.
    await page.locator(".computer-switcher__menu button").nth(port === 7472 ? 0 : 1).click();
    await expect(page.locator(".blocked__head").first()).toBeVisible();
  }
  expect(await counts(7472)).toEqual({ live: 1, handshakes: 1 });
  expect(await counts(7572)).toEqual({ live: 1, handshakes: 1 });
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("section").filter({ hasText: "127.0.0.1:7572" }).getByRole("button", { name: "Revoke this browser’s access" }).click();
  await expect.poll(async () => (await counts(7572)).live).toBe(0);
  expect(await counts(7472)).toEqual({ live: 1, handshakes: 1 });
  expect((await (await request.get("http://127.0.0.1:7572/__hosted/device-count")).json()).count).toBe(0);
  await page.getByRole("button", { name: /Connect to .*127\.0\.0\.1:7472/ }).click();
  await page.locator(".blocked__head").first().click();
  await page.locator("textarea").fill("still-connected-after-revocation");
  await page.locator(".compose__send").click();
  await expect.poll(async () => (await (await request.get("/__hosted/writes")).json()).writes.length).toBeGreaterThan(0);
 });

test("a notification opens its own computer even when another was selected", async ({ page, request }) => {
  await pair(page, true);
  const firstId = new URLSearchParams(code.split("#")[1]).get("server")!;
  await page.locator(".blocked__head").first().click();
  const pane = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await page.goto(`/pwa/notification?pane=${encodeURIComponent(pane)}&computer=${encodeURIComponent(firstId)}`);
  await page.locator("textarea").fill("notification-to-first-computer");
  await page.locator(".compose__send").click();
  const writes = async (port: number) => (await (await request.get(`http://127.0.0.1:${port}/__hosted/writes`)).json()).writes;
  await expect.poll(async () => (await writes(7472)).length).toBe(1);
  expect(await writes(7572)).toHaveLength(0);
  await page.goto(`/pwa/notification?pane=${encodeURIComponent(pane)}&computer=forgotten-computer`);
  await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("a delayed sign-out removes its own computer after switching to another", async ({ page, request }) => {
  await pair(page, true);
  const second = await (await request.post("http://127.0.0.1:7572/__hosted/reset")).json();
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.getByRole("button", { name: "Manage computers", exact: true }).click();
  await page.getByRole("button", { name: "Add a computer", exact: true }).click();
  await page.getByLabel("Pairing code", { exact: true }).fill(second.code);
  await page.getByLabel("Remember this browser").check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await request.post("http://127.0.0.1:7572/__hosted/hold-logout");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:7572/__hosted/writes")).json()).requests.some((r: {path:string}) => r.path === "/api/auth/logout")).toBe(true);
  await page.getByLabel("Switch computer", { exact: true }).click();
  await page.locator(".computer-switcher__menu button").first().click();
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  await request.post("http://127.0.0.1:7572/__hosted/release-logout");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:7572/__hosted/connections")).json()).live).toBe(0);
  await expect(page.locator(".blocked__head").first()).toBeVisible();
  expect((await (await request.get("/__hosted/connections")).json()).live).toBe(1);
});
