/**
 * Checks that the composer survives the on-screen keyboard.
 *
 * On iOS the keyboard overlays the layout viewport rather than shrinking it, so
 * an app sized with `height: 100%` keeps its full height while the bottom half
 * is covered — burying the key bar, the text box and Send exactly when you tap
 * to type. `src/viewport.ts` sizes from `visualViewport` instead.
 *
 * Headless Chrome cannot raise a keyboard, but shrinking the viewport
 * reproduces what one does: the visual viewport gets shorter while the content
 * stays. If the composer is still on screen at the reduced height, it will
 * still be on screen above a real keyboard.
 *
 *   HERDRUI_PASSCODE=**** bun run server/scripts/check-keyboard-layout.ts
 */
const BASE = process.env.HERDRUI_URL ?? "http://127.0.0.1:7171";
const PASSCODE = process.env.HERDRUI_PASSCODE ?? "4821";

/** iPhone 15 Pro, then the same device with a keyboard taking ~55% of it. */
const FULL = { width: 393, height: 852 };
const WITH_KEYBOARD = { width: 393, height: 380 };

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passcode: PASSCODE }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("login did not return a cookie");

const session = await fetch(`${BASE}/api/session`, { headers: { cookie } });
const { panes } = (await session.json()) as { panes: { paneId: string; isAgent: boolean }[] };
const pane = panes.find((p) => p.isAgent)?.paneId;
if (!pane) throw new Error("no agent pane to inspect");

const port = 9334;
const chrome = Bun.spawn(
  [
    "google-chrome",
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/herdrui-keyboard-check",
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

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

const metrics = (size: { width: number; height: number }) =>
  send(
    "Emulation.setDeviceMetricsOverride",
    { ...size, deviceScaleFactor: 2, mobile: true },
    sessionId,
  );

await metrics(FULL);
const [name, value] = cookie.split("=");
await send("Network.setCookie", { name, value, domain: new URL(BASE).hostname, path: "/" }, sessionId);
await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: `${BASE}/pane/${encodeURIComponent(pane)}` }, sessionId);
await Bun.sleep(9_000);

/** Is the Send button fully inside the visible viewport? */
const probe = `(() => {
  const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send');
  const keys = document.querySelector('.keys');
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (!send) return JSON.stringify({ found: false });
  const s = send.getBoundingClientRect();
  const k = keys ? keys.getBoundingClientRect() : null;
  return JSON.stringify({
    found: true,
    viewportHeight: Math.round(vh),
    appHeight: getComputedStyle(document.querySelector('.app')).height,
    sendBottom: Math.round(s.bottom),
    sendVisible: s.bottom <= vh + 1 && s.top >= -1,
    keyBarVisible: k ? (k.bottom <= vh + 1 && k.top >= -1) : false,
  });
})()`;

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label} — ${detail}`);
  if (!ok) failures++;
};

for (const [label, size] of [
  ["keyboard closed", FULL],
  ["keyboard open", WITH_KEYBOARD],
] as const) {
  await metrics(size);
  await Bun.sleep(1_200);
  const { result } = await send("Runtime.evaluate", { expression: probe, returnByValue: true }, sessionId);
  const r = JSON.parse(result.value as string) as Record<string, unknown>;

  check(
    `${label}: composer reachable`,
    r.found === true && r.sendVisible === true && r.keyBarVisible === true,
    `app ${r.appHeight}, viewport ${r.viewportHeight}px, Send ends at ${r.sendBottom}px`,
  );
}

socket.close();
chrome.kill();

console.log(failures === 0 ? "\nthe composer stays above the keyboard" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

export {};
