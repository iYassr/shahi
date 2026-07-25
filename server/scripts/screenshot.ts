/**
 * Screenshots the app at phone size, driving headless Chrome over CDP.
 *
 * The point is to see what the phone sees without a phone in hand. It logs in
 * exactly as the phone does — POST the passcode, keep the cookie — rather than
 * disabling the gate to take a picture, so what it captures is a genuinely
 * authenticated session.
 *
 * Chrome is driven over the DevTools protocol directly rather than through
 * Playwright: Chrome is already installed on this host, and the alternative was
 * a multi-gigabyte image pull for something a WebSocket and four commands
 * cover.
 *
 *   HERDRUI_PASSCODE=1234 bun run server/scripts/screenshot.ts /pane/wE%3Ap1 out.png
 */
// Both come from the environment. A default host and a default passcode in a
// checked-in file are a credential in the repository, however private it is.
const BASE = process.env.HERDRUI_URL ?? "http://127.0.0.1:7171";
const PASSCODE = process.env.HERDRUI_PASSCODE;
if (!PASSCODE) {
  console.error("Set HERDRUI_PASSCODE (and HERDRUI_URL if it is not on loopback).");
  process.exit(1);
}

const path = process.argv[2] ?? "/";
const out = process.argv[3] ?? "shot.png";
const settleMs = Number(process.argv[4] ?? 9000);

/** Authenticate first; the screenshot is of an authenticated session. */
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passcode: PASSCODE }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("login did not return a cookie");

const port = 9333;
const profile = "/tmp/herdrui-shot-profile";
const chrome = Bun.spawn(
  [
    "google-chrome",
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

/** Chrome takes a moment to open the debugging port. */
async function endpoint(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("chrome never opened its debugging port");
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map<number, (result: unknown) => void>();
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
  if (msg.id !== undefined) pending.get(msg.id)?.(msg.result);
});

const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

// iPhone 15 Pro viewport, so the screenshot matches what the phone renders.
await send(
  "Emulation.setDeviceMetricsOverride",
  { width: 393, height: 852, deviceScaleFactor: 2, mobile: true },
  sessionId,
);

const [name, value] = cookie.split("=");
const url = new URL(BASE);
await send(
  "Network.setCookie",
  { name, value, domain: url.hostname, path: "/" },
  sessionId,
);

await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: `${BASE}${path}` }, sessionId);
await Bun.sleep(settleMs);

const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
await Bun.write(out, Buffer.from(data, "base64"));
console.log(`  wrote ${out}`);

socket.close();
chrome.kill();

export {};
