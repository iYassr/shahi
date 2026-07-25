/**
 * End-to-end check of the HTTP and WebSocket surface against a running server.
 *
 * Exercises the auth boundary, the dashboard projection, the watch/unwatch
 * lifecycle, and live frame delivery. Read-only with respect to herdr: it never
 * sends input to any pane.
 *
 * Start the server first, then:
 *   bun run server/scripts/check-http-live.ts [passcode]
 */
const BASE = process.env.HERDRUI_URL ?? "http://127.0.0.1:7171";
const passcode = process.argv[2] ?? "4821";

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label} — ${detail}`);
  if (!ok) failures++;
}

// --- the gate ---
const status = (await (await fetch(`${BASE}/api/auth/status`)).json()) as { required: boolean };
check("auth status is public", status.required === true, JSON.stringify(status));

for (const path of ["/api/session", "/api/rpc", "/ws"]) {
  const res = await fetch(`${BASE}${path}`);
  check(`${path} refuses anonymous access`, res.status === 401, `${res.status}`);
}

const bad = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passcode: "definitely-wrong" }),
});
check("wrong passcode is refused", bad.status === 401, `${bad.status}`);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passcode }),
});
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0] ?? "";
check(
  "correct passcode issues an HttpOnly cookie",
  login.status === 200 && setCookie.includes("HttpOnly") && cookie.length > 20,
  `${login.status}, ${setCookie.slice(0, 40)}…`,
);

const forged = await fetch(`${BASE}/api/session`, {
  headers: { cookie: `herdrui_session=${Date.now() + 1e9}.forged-signature` },
});
check("a forged cookie is refused", forged.status === 401, `${forged.status}`);

const authed = { cookie } as Record<string, string>;

// --- dashboard ---
type DashPane = { paneId: string; status: string; title: string | null; isAgent: boolean };
const session = (await (await fetch(`${BASE}/api/session`, { headers: authed })).json()) as {
  panes: DashPane[];
};
const order = ["blocked", "working", "done", "idle", "unknown"];
const ranks = session.panes.map((p) => order.indexOf(p.status));
check(
  "dashboard sorts by urgency",
  ranks.every((r, i) => i === 0 || (ranks[i - 1] ?? 0) <= r),
  session.panes.map((p) => p.status.slice(0, 1)).join(""),
);

const agents = session.panes.filter((p) => p.isAgent).length;
check(
  "agent panes are distinguished from plain shells",
  agents > 0 && agents < session.panes.length,
  `${agents} agents of ${session.panes.length} panes`,
);

check(
  "panes carry a human-readable title",
  session.panes.filter((p) => p.title).length > 0,
  session.panes.find((p) => p.title)?.title ?? "(none)",
);

// --- a single pane ---
const target =
  session.panes.find((p) => p.status === "working" && p.isAgent) ??
  session.panes.find((p) => p.isAgent);
if (!target) throw new Error("no agent panes in the session to inspect");

const paneId = target.paneId;
const detail = (await (
  await fetch(`${BASE}/api/panes/${encodeURIComponent(paneId)}`, { headers: authed })
).json()) as {
  layout?: { area?: { width: number; height: number } };
  frame?: { ansi?: string };
};
check(
  "pane detail includes layout dimensions for xterm.js",
  (detail.layout?.area?.width ?? 0) > 0 && (detail.layout?.area?.height ?? 0) > 0,
  `${paneId}: ${detail.layout?.area?.width}x${detail.layout?.area?.height}`,
);
check(
  "pane detail includes a raw ANSI frame",
  typeof detail.frame?.ansi === "string" && detail.frame.ansi.includes("\x1b"),
  `${detail.frame?.ansi?.length ?? 0} bytes, escapes ${detail.frame?.ansi?.includes("\x1b") ? "present" : "MISSING"}`,
);

const missing = await fetch(`${BASE}/api/panes/nope%3Ap9`, { headers: authed });
check("unknown pane is a 404", missing.status === 404, `${missing.status}`);

// --- websocket ---
const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`, { headers: authed } as never);
const received: Record<string, number> = {};
const framePanes = new Set<string>();

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  received[msg.type] = (received[msg.type] ?? 0) + 1;
  if (msg.type === "frame") framePanes.add(msg.frame.paneId);
});

await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("websocket failed to connect")));
  setTimeout(() => reject(new Error("websocket connect timed out")), 5_000);
});

await Bun.sleep(500);
check("websocket sends the session on connect", (received.session ?? 0) >= 1, `${received.session ?? 0} session message(s)`);

ws.send(JSON.stringify({ type: "watch", paneId }));
await Bun.sleep(6_000);

check(
  "watching a pane streams its frames",
  framePanes.has(paneId),
  `${received.frame ?? 0} frame(s) for ${[...framePanes].join(", ") || "no panes"}`,
);
check(
  "frames are scoped to the watched pane only",
  framePanes.size <= 1,
  `${framePanes.size} distinct pane(s) streamed`,
);

const beforeUnwatch = received.frame ?? 0;
ws.send(JSON.stringify({ type: "unwatch" }));
await Bun.sleep(3_000);
check(
  "unwatching stops the stream",
  (received.frame ?? 0) === beforeUnwatch,
  `${(received.frame ?? 0) - beforeUnwatch} frame(s) after unwatch`,
);

ws.close();

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

export {};
