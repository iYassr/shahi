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
