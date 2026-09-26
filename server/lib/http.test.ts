/**
 * The HTTP surface, stood up on a fake herdr.
 *
 * Every test here is named for a way in that was open: a socket that outlived
 * its cookie, a page on another origin posting with the victim's cookie, a
 * flood of `/api/meta`, a body of `null` answered with a stack trace. The
 * server is the real `createServer`; only herdr is faked, with the three
 * methods these routes reach.
 */
import { SHAHI_API_VERSION } from "@shahi/shared";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { Devices, Pairing } from "./pairing";
import type { Config } from "./config";
import { HerdrClient, HerdrError } from "./herdr-client";
import { createServer, MAX_PROMPT_BYTES } from "./http";
import { Poller } from "./poller";
import { PushService } from "./push";
import { SessionStore } from "./state";
import { TranscriptStore } from "./transcript";
import { ComputerControl } from "./control";
import { atomicJson } from "../../plugin/releases/storage";

const PANE = "w1:p1";
const PASSCODE = "2468";

/** What the fake pane shows; tests that answer a prompt set it. */
let screen = "";
/**
 * What the fake agent draws once a key lands, as a real one moves on from the
 * question it was answering. Without it an answer waits out its full settle
 * time for a screen that never changes.
 */
let afterKeys: string | null = "";
/** Set before a boot() to make the fake pane an agent in that state. */
let agentStatus: string | null = null;
/**
 * An agent herdr has started in the fake pane that the mirror has not seen
 * yet: `pane.get` reports it in this state while the snapshot lists no agent.
 */
let unmirroredAgent: string | null = null;

/** Set to make the agent the fake herdr launches exit before it is ready. */
let agentExitsWhileStarting = false;

/** Set before a boot() to change who occupies the fake pane (agent, session, terminal). */
let occupant: Record<string, unknown> = {};

/** Set to the error herdr's client gives while herdr is down; writes then fail with it. */
let herdrDown: unknown = null;
const WRITES = new Set(["pane.send_text", "pane.send_keys", "agent.prompt", "tab.create", "agent.start"]);

/** The error a real client gives when herdr's socket is not there. */
function noHerdrSocket(): Promise<unknown> {
  const client = new HerdrClient({ socketPath: join(tmpdir(), `shahi-http-no-herdr-${process.pid}.sock`) });
  return client.rpc("ping", {}).then(() => { throw new Error("a socket answered"); }, (err) => err);
}

/** The last fake herdr's session, for a test that changes what herdr reports. */
let herdrSnapshot: { panes: Record<string, unknown>[] };

/** Enough of herdr for the routes under test; anything else is refused. */
function fakeHerdr(calls: { method: string; params: unknown }[], freshCreation = false): HerdrClient {
  const pane = {
    pane_id: PANE,
    workspace_id: "w1",
    tab_id: "t1",
    agent_status: "unknown",
    agent: null,
    display_agent: null,
    terminal_title: "zsh",
    terminal_title_stripped: "zsh",
    label: null,
    cwd: "/tmp",
    focused: true,
    agent_session: null,
    ...occupant,
  };
  const snapshot = {
    version: "0.8.2",
    protocol: 20,
    workspaces: [{ workspace_id: "w1", label: "one", agent_status: "unknown", pane_count: 1, tab_count: 1, focused: true }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1, agent_status: "unknown", pane_count: 1, focused: true }],
    // An agent's pane carries its status in both lists, as herdr's do.
    panes: [agentStatus ? { ...pane, agent: "claude", agent_status: agentStatus } : pane],
    agents: agentStatus ? [{ ...pane, agent: "claude", agent_status: agentStatus }] : [],
    layouts: [],
    focused_pane_id: PANE,
  };
  herdrSnapshot = snapshot;
  return {
    rpc: async (method: string, params: unknown) => {
      if (herdrDown && WRITES.has(method)) throw herdrDown;
      calls.push({ method, params });
      switch (method) {
        case "session.snapshot":
          return { snapshot: structuredClone(snapshot) };
        case "pane.send_keys":
          if (afterKeys !== null) screen = afterKeys;
          return {};
        case "pane.send_text":
          return {};
        case "pane.read":
          return { read: { text: screen } };
        case "pane.get": {
          const status = unmirroredAgent ?? agentStatus;
          return { pane: status ? { ...pane, agent: "claude", agent_status: status } : pane };
        }
        case "tab.create":
          if (freshCreation) {
            const workspaceId = (params as { workspace_id: string }).workspace_id;
            const next = { ...pane, pane_id: `${workspaceId}:new${snapshot.panes.length}`, workspace_id: workspaceId, tab_id: `new${snapshot.tabs.length}` };
            snapshot.panes.push(next);
            snapshot.tabs.push({ ...snapshot.tabs[0]!, tab_id: next.tab_id, workspace_id: workspaceId });
            return { root_pane: { pane_id: next.pane_id }, tab: { tab_id: next.tab_id } };
          }
          return { root_pane: { pane_id: PANE }, tab: { tab_id: "t1" } };
        case "workspace.create": {
          const next = { ...snapshot.workspaces[0]!, workspace_id: `w${snapshot.workspaces.length + 1}` };
          snapshot.workspaces.push(next);
          return { workspace: next };
        }
        case "agent.start":
          await Bun.sleep(25);
          return agentExitsWhileStarting ? { agent: { launch_pending: true, interactive_ready: false } } : {};
        case "agent.get":
          throw new HerdrError("agent_not_found", `agent target ${(params as { target: string }).target} not found`, "agent.get");
        case "tab.close":
          return {};
        case "server.agent_manifests":
          return { manifests: [{ agent: "claude" }, { agent: "codex" }] };
        case "workspace.list":
          return { workspaces: snapshot.workspaces };
        default:
          throw new Error(`fake herdr has no ${method}`);
      }
    },
  } as unknown as HerdrClient;
}

interface Booted {
  base: string;
  cookie: string;
  calls: { method: string; params: unknown }[];
  push: PushService;
  dispatch: ReturnType<typeof createServer>["dispatch"];
  uploadDir: string;
  store: SessionStore;
  transcript: TranscriptStore;
  herdr: typeof herdrSnapshot;
  poller: Poller;
  stop: () => void;
}

let passcodeHash = "";
const scratch = mkdtempSync(join(tmpdir(), "shahi-http-"));
let booted = 0;

async function boot({ sessionTtlMs = 60_000, heartbeatMs = 20_000, relay = false, recovery = false, recoveryRoot = "", freshCreation = false, allowedHosts = [] as string[] } = {}): Promise<Booted> {
  const calls: Booted["calls"] = [];
  const client = fakeHerdr(calls, freshCreation);
  const dataPath = join(scratch, `shahi-${booted++}.sqlite`);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    socketPath: "",
    dataPath,
    passcodeHash,
    sessionSecret: "test-secret",
    sessionTtlMs,
    vapid: null,
    webRoot: null,
    relayUrl: null,
    allowedHosts,
  };
  // Wired the way index.ts wires them: device sessions are checked against the
  // devices table on every request, so revocation is immediate.
  const db = new Database(dataPath, { create: true });
  const devices = new Devices(db);
  const pairing = new Pairing();
  const auth = new Auth({
    passcodeHash,
    sessionSecret: config.sessionSecret,
    sessionTtlMs,
    deviceActive: (id) => devices.isActive(id),
  });
  const store = new SessionStore(client);
  await store.resync();
  const transcript = new TranscriptStore(join(scratch, `t-${booted}.sqlite`));
  const poller = new Poller(client, store, transcript);
  poller.on("error", () => undefined);
  const push = new PushService(db, config);
  const uploadDir = join(scratch, `uploads-${booted}`);
  const server = createServer(
    {
      config,
      auth,
      client,
      store,
      poller,
      transcript,
      push,
      pairing,
      devices,
      serverId: "test-server",
      ...(recovery ? { control: new ComputerControl("test-server", () => ({ state: "offline", message: "herdr is offline" }), recoveryRoot || undefined) } : {}),
      ...(relay ? { relay: () => ({ url: "https://relay.test", connected: true }) } : {}),
    },
    { heartbeatMs, uploadDir },
  );
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { base, cookie, calls, push, dispatch: server.dispatch, uploadDir, store, transcript, herdr: herdrSnapshot, poller, stop: () => server.stop(true) };
}

/**
 * A request as raw bytes, for a Host that `fetch` would not send; resolves
 * with the status and the rest of the response.
 */
function raw(base: string, request: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = connect(Number(new URL(base).port), "127.0.0.1", () => sock.write(request));
    const done = () => {
      clearTimeout(timer);
      sock.destroy();
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number(text.split(" ")[1]), text });
    };
    // An upgrade request cannot also ask for the connection to close.
    const timer = setTimeout(done, 1_000);
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", done);
    sock.on("error", reject);
  });
}

/** Opens a socket and resolves with how it ended, or "open" once it is up. */
function socket(base: string, headers: Record<string, string>): Promise<{ open: boolean; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, { headers } as never);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({ open: true });
    };
    ws.onclose = (event) => {
      if (!opened) resolve({ open: false, code: event.code });
    };
  });
}

let s: Booted;

beforeAll(async () => {
  passcodeHash = await Auth.hashPasscode(PASSCODE);
  s = await boot();
});

afterAll(() => {
  s.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the gate", () => {
  test("every /api route and the socket refuse a request without the cookie", async () => {
    expect((await fetch(`${s.base}/api/session`)).status).toBe(401);
    expect((await fetch(`${s.base}/api/diagnostics`)).status).toBe(401);
    expect(await socket(s.base, {})).toMatchObject({ open: false });
  });

  test("diagnostics require a session and expose aggregate counters without session content", async () => {
    const response = await fetch(`${s.base}/api/diagnostics`, { headers: { cookie: s.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { requests: object; rssBytes: number };
    expect(body.rssBytes).toBeGreaterThan(0);
    expect(Object.keys(body.requests).length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(PANE);
    expect(JSON.stringify(body)).not.toContain(s.cookie);
  });

  test("every response says nosniff, no frames, no referrer", async () => {
    const res = await fetch(`${s.base}/api/meta`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-eval");
  });

  test("cookies on an HTTPS reverse-proxy hop are Secure, including logout", async () => {
    const login = await fetch(`${s.base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ passcode: PASSCODE }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("; Secure");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const logout = await fetch(`${s.base}/api/auth/logout`, { method: "POST", headers: { cookie, "x-forwarded-proto": "https" } });
    expect(logout.headers.get("set-cookie")).toContain("; Secure");
    expect((await fetch(`${s.base}/api/session`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("the routes anyone can reach are rate limited by address", () => {
  test("a flood from one client behind the owner's proxy is refused with retry-after; another client is not", async () => {
    // The proxy names itself in Host and says who it is forwarding; that is
    // the only case in which x-forwarded-for is believed.
    const box = await boot({ allowedHosts: ["box.tailnet.ts.net"] });
    try {
      const from = (ip: string, path = "/api/meta", cookie = "") => raw(box.base,
        `GET ${path} HTTP/1.1\r\nHost: box.tailnet.ts.net\r\nX-Forwarded-For: ${ip}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}Connection: close\r\n\r\n`);
      let refused: { status: number; text: string } | null = null;
      for (let i = 0; i < 40 && !refused; i++) {
        const res = await from("203.0.113.9");
        if (res.status === 429) refused = res;
      }
      expect(refused?.status).toBe(429);
      expect(Number(refused?.text.match(/retry-after: (\d+)/i)?.[1])).toBeGreaterThan(0);
      expect((await from("203.0.113.10")).status).toBe(200);
      // The gated routes are not behind the limiter: the flood above did not
      // touch them.
      expect((await from("203.0.113.9", "/api/session", box.cookie)).status).toBe(200);
    } finally { box.stop(); }
  });

  // September 2026 pre-release bug hunt: the listener binds only loopback, so
  // every peer is loopback, and x-forwarded-for was believed from every one:
  // any local process got a fresh bucket per request by rotating it.
  test("rotating x-forwarded-for cannot reset the pre-auth limit", async () => {
    const box = await boot();
    try {
      const status = (headers: Record<string, string> = {}) => fetch(`${box.base}/api/auth/status`, { headers }).then((r) => r.status);
      for (let i = 0; i < 35; i++) await status();
      expect(await status()).toBe(429);
      const rotated = [];
      for (let i = 0; i < 10; i++) rotated.push(await status({ "x-forwarded-for": `10.0.0.${i}` }));
      expect(rotated).toEqual(Array(10).fill(429));
    } finally { box.stop(); }
  });
});

describe("answering a prompt", () => {
  const url = () => `${s.base}/api/panes/${encodeURIComponent(PANE)}/answer`;
  const post = (body: unknown) =>
    fetch(url(), {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const pressed = (from: number) =>
    s.calls.slice(from).filter((c) => c.method === "pane.send_keys").map((c) => (c.params as { keys: string[] }).keys);

  test("walks a cursor menu from the lit row and confirms, in one send", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__trust-folder__text.txt"), "utf8");
    const before = s.calls.length;
    expect((await post({ index: 1, label: "No, exit" })).status).toBe(200);
    expect(pressed(before)).toEqual([["Up", "Enter"]]);
  });

  test("presses the digit of a numbered menu", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__w4-p2__text.txt"), "utf8");
    const before = s.calls.length;
    expect((await post({ index: 2, label: "Yes, manually approve edits" })).status).toBe(200);
    expect(pressed(before)).toEqual([["2"]]);
  });

  test("is a 409 and no keystroke once the prompt is gone or has changed", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "idle__w4-p1__text.txt"), "utf8");
    const before = s.calls.length;
    const gone = await post({ index: 1, label: "No, exit" });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { code: string }).code).toBe("prompt_gone");

    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__trust-folder__text.txt"), "utf8");
    const changed = await post({ index: 1, label: "Yes, and bypass permissions" });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { code: string }).code).toBe("prompt_changed");
    expect(pressed(before)).toEqual([]);
  });

  test("refuses a body without the option it is answering", async () => {
    expect((await post({ index: 1 })).status).toBe(400);
    expect((await post({ label: "No, exit" })).status).toBe(400);
  });
});

describe("a browser on another origin", () => {
  const url = () => `${s.base}/api/panes/${encodeURIComponent(PANE)}/keys`;
  const post = (origin?: string) =>
    fetch(url(), {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "text/plain", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ keys: ["Enter"] }),
    });

  test("cannot press keys with the victim's cookie, even without a preflight", async () => {
    const before = s.calls.length;
    expect((await post("https://evil.tailnet.ts.net")).status).toBe(403);
    expect(s.calls.length).toBe(before);
  });

  test("cannot open the socket", async () => {
    expect(await socket(s.base, { cookie: s.cookie, origin: "https://evil.tailnet.ts.net" })).toMatchObject({ open: false });
  });

  test("while the app's own origin and the native app (no Origin) still can", async () => {
    expect((await post(s.base)).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(await socket(s.base, { cookie: s.cookie })).toMatchObject({ open: true });
  });

  test("and so can the app behind a proxy that rewrote Host but forwarded it", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        cookie: s.cookie,
        "content-type": "application/json",
        origin: "https://box.tailnet.ts.net",
        "x-forwarded-host": "box.tailnet.ts.net",
      },
      body: JSON.stringify({ keys: ["Enter"] }),
    });
    expect(res.status).toBe(200);
  });
});

// Review findings F26/F36: a page whose name was rebound to 127.0.0.1 is
// same-origin with itself, so the Origin check passed it, and it could guess
// the four-digit passcode through the login until it held a session.
describe("a page that rebound its own name to this machine", () => {
  const port = () => new URL(s.base).port;
  const request = (method: string, path: string, host: string, body = "") =>
    `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;

  test("gets no session even with the right passcode, and learns nothing from meta", async () => {
    const host = `attacker.example:${port()}`;
    const login = await raw(s.base, request("POST", "/api/auth/login", host, JSON.stringify({ passcode: PASSCODE })));
    expect(login.status).toBe(403);
    expect(login.text.toLowerCase()).not.toContain("set-cookie");
    const meta = await raw(s.base, request("GET", "/api/meta", host));
    expect(meta.status).toBe(403);
    expect(meta.text).not.toContain("test-server");
    // Nor does the socket open for it.
    const upgrade = await raw(s.base, `GET /ws HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nCookie: ${s.cookie}\r\n` +
      "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    expect(upgrade.status).toBe(403);
  });

  test("while every loopback spelling still answers, on any port an SSH forward chose", async () => {
    for (const host of [`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`, "127.0.0.1:52022", "LOCALHOST", "127.0.0.1"]) {
      expect({ host, status: (await raw(s.base, request("GET", "/api/meta", host))).status }).toEqual({ host, status: 200 });
    }
    for (const host of ["localhost.attacker.example", "127.0.0.1.nip.io", "127.0.0.1@attacker.example", "[::1]x"]) {
      expect({ host, status: (await raw(s.base, request("GET", "/api/meta", host))).status }).toEqual({ host, status: 403 });
    }
  });

  // Integration of the review fixes: refusing every non-loopback name also
  // refused `tailscale serve`, the documented way to give the local web app
  // the HTTPS that push needs. The owner can name their own proxy; nothing
  // else gets through, including names built around it.
  test("a reverse proxy the owner listed still answers, and only that name", async () => {
    const box = await boot({ allowedHosts: ["box.tailnet.ts.net"] });
    try {
      const status = async (host: string) => (await raw(box.base, request("GET", "/api/meta", host))).status;
      expect(await status("box.tailnet.ts.net")).toBe(200);
      expect(await status("BOX.tailnet.ts.net:443")).toBe(200);
      for (const host of ["attacker.example", "box.tailnet.ts.net.attacker.example", "evil-box.tailnet.ts.net", "x.box.tailnet.ts.net"]) {
        expect({ host, status: await status(host) }).toEqual({ host, status: 403 });
      }
    } finally { box.stop(); }
    // And with nothing listed, the proxy's name is refused like any other.
    expect((await raw(s.base, request("GET", "/api/meta", "box.tailnet.ts.net"))).status).toBe(403);
  });

  // September 2026 pre-release bug hunt: the port was checked for 1–5 digits,
  // so 99999 passed, `new URL` then threw outside the handler, and the answer
  // was Bun's bare 500: no CSP, no nosniff, and not counted in diagnostics.
  test("a Host with a port no socket can have is refused like any other, with every hardening header", async () => {
    for (const host of ["127.0.0.1:99999", "localhost:65536", "[::1]:70000"]) {
      const res = await raw(s.base, request("GET", "/api/meta", host));
      expect({ host, status: res.status }).toEqual({ host, status: 403 });
      expect(res.text.toLowerCase()).toContain("x-content-type-options: nosniff");
      expect(res.text.toLowerCase()).toContain("content-security-policy:");
    }
    const box = await boot({ allowedHosts: ["box.tailnet.ts.net"] });
    try {
      expect((await raw(box.base, request("GET", "/api/meta", "box.tailnet.ts.net:99999"))).status).toBe(403);
      expect((await raw(box.base, request("GET", "/api/meta", "box.tailnet.ts.net:65535"))).status).toBe(200);
    } finally { box.stop(); }
  });

  test("and the relay, which carries no browser's Host, is not affected", async () => {
    const meta = await s.dispatch(new Request("http://relay.invalid/api/meta"), "relay-host-test");
    expect(meta.status).toBe(200);
  });
});

// Review finding F37: sign-in attempts waiting in the throttle held the slots
// every phone shares, so thirty-two bad logins made the box answer 503.
describe("sign-in attempts cannot crowd out the phones", () => {
  test("logins that never finish leave the box answering a paired phone", async () => {
    const box = await boot();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    try {
      // Admission is decided before the first await, so these are all in
      // flight, and holding whatever they were given, when the phone asks.
      const flood = Array.from({ length: 40 }, () => box.dispatch(new Request(`${box.base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ start: (c) => { streams.push(c); c.enqueue(new TextEncoder().encode('{"passcode":')); } }),
        duplex: "half",
      } as RequestInit), "flood"));
      const phone = await box.dispatch(new Request(`${box.base}/api/session`, { headers: { cookie: box.cookie } }), "phone");
      expect(phone.status).toBe(200);
      expect(await (await fetch(`${box.base}/api/session`, { headers: { cookie: box.cookie } })).status).toBe(200);
      // Most of the flood is turned away at once rather than queued.
      const settled = await Promise.all(flood.slice(8).map((r) => r.then((res) => res.status)));
      expect(new Set(settled)).toEqual(new Set([429]));
      // Pairing a phone has its own budget, untouched by the login flood.
      const { secret } = await (await fetch(`${box.base}/api/pair`, { method: "POST", headers: { cookie: box.cookie } })).json() as { secret: string };
      const claim = await fetch(`${box.base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, deviceName: "During a flood" }) });
      expect(claim.status).toBe(200);
    } finally {
      for (const stream of streams) stream.error(new Error("gone"));
      box.stop();
    }
  });

  test("a login body is refused once it is larger than any passcode", async () => {
    const box = await boot();
    try {
      const res = await fetch(`${box.base}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode: PASSCODE, padding: "x".repeat(64 * 1024) }),
      });
      expect(res.status).toBe(413);
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally { box.stop(); }
  });
});

describe("a socket does not outlive its session", () => {
  test("it is closed with 4001 once the cookie that opened it has expired", async () => {
    const short = await boot({ sessionTtlMs: 500, heartbeatMs: 100 });
    try {
      const ended = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${short.base.replace(/^http/, "ws")}/ws`, { headers: { cookie: short.cookie } } as never);
        ws.onclose = (event) => resolve(event.code);
        ws.onerror = () => reject(new Error("socket refused; the cookie should be fresh here"));
        setTimeout(() => reject(new Error("socket still open 2s after its session expired")), 2_000);
      });
      expect(ended).toBe(4001);
    } finally {
      short.stop();
    }
  });

  // Pre-release bug hunt: the socket closed, but the session's push
  // registrations stayed and received every notification indefinitely.
  test("nor do the notifications it registered for", async () => {
    const short = await boot({ sessionTtlMs: 500 });
    const realFetch = globalThis.fetch;
    const sentTo: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith("https://exp.host/")) return realFetch(input, init);
      const messages = JSON.parse(String(init?.body)) as { to: string }[];
      sentTo.push(...messages.map((m) => m.to));
      return Response.json({ data: messages.map(() => ({ status: "ok" })) });
    }) as typeof fetch;
    const post = (path: string, body: unknown, cookie: string) => realFetch(short.base + path, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const login = async () => ((await realFetch(`${short.base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }),
    })).headers.get("set-cookie") ?? "").split(";")[0]!;
    try {
      expect((await post("/api/push/expo", { token: "ExpoPushToken[expiring]" }, short.cookie)).status).toBe(200);
      expect((await post("/api/push/subscribe", { endpoint: "https://push.example/expiring", keys: { p256dh: "x", auth: "y" } }, short.cookie)).status).toBe(200);
      expect(short.push.count()).toBe(2);
      await Bun.sleep(600);

      const later = await login();
      expect(await (await post("/api/push/test", {}, later)).json()).toEqual({ sent: 0 });
      expect(sentTo).toEqual([]);
      expect(short.push.count()).toBe(0);

      // Signing in again and registering again keeps the phone notified.
      expect((await post("/api/push/expo", { token: "ExpoPushToken[expiring]" }, later)).status).toBe(200);
      expect(await (await post("/api/push/test", {}, later)).json()).toEqual({ sent: 1 });
      expect(sentTo).toEqual(["ExpoPushToken[expiring]"]);
    } finally {
      globalThis.fetch = realFetch;
      short.stop();
    }
  });
});

describe("clients watching panes", () => {
  // Each watcher added a poller "frame" listener of its own beside the two
  // permanent ones, so the ninth crossed Node's default limit of ten and the
  // service log printed "MaxListenersExceededWarning: Possible EventEmitter
  // memory leak detected" (pre-release bug hunt, September 2026).
  test("a dozen clients watching panes add no poller listeners and leave none behind", async () => {
    const box = await boot();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    const sockets: WebSocket[] = [];
    try {
      const baseline = box.poller.listenerCount("frame");
      for (let n = 0; n < 12; n++) {
        const ws = new WebSocket(`${box.base.replace(/^http/, "ws")}/ws`, { headers: { cookie: box.cookie } } as never);
        sockets.push(ws);
        // A watch is answered with the pane's frame, which says it was taken.
        const watched = new Promise<void>((resolve, reject) => {
          ws.onmessage = (event) => { if (JSON.parse(String(event.data)).type === "frame") resolve(); };
          ws.onerror = () => reject(new Error("socket refused"));
          setTimeout(() => reject(new Error("no frame 2s after watching")), 2_000);
        });
        await new Promise((resolve) => { ws.onopen = resolve; });
        ws.send(JSON.stringify({ type: "watch", paneId: PANE }));
        await watched;
        expect(box.poller.listenerCount("frame")).toBe(baseline);
      }
      for (const ws of sockets.splice(0)) ws.close();
      await Bun.sleep(50);
      expect(box.poller.listenerCount("frame")).toBe(baseline);
      expect(warnings).not.toContain("MaxListenersExceededWarning");
    } finally {
      for (const ws of sockets) ws.close();
      process.off("warning", onWarning);
      box.stop();
    }
  });
});

describe("claiming a pairing code", () => {
  // The relay transport cannot carry a cookie, so the claim's body says who
  // the phone now is and hands over its half of the relay key; the cookie
  // stays for a phone that reached the box directly.
  test("answers the device id and secret in the body beside the cookie", async () => {
    const mint = await fetch(`${s.base}/api/pair`, { method: "POST", headers: { cookie: s.cookie } });
    const { secret } = (await mint.json()) as { secret: string };
    const res = await fetch(`${s.base}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, deviceName: "Phone" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deviceId: string; deviceSecret: string; device: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(body.device.id);
    expect(Buffer.from(body.deviceSecret, "base64url")).toHaveLength(32);
    expect(res.headers.get("set-cookie")).toContain(`.${body.deviceId}.`);
  });
});

describe("raw RPC", () => {
  test("is refused to a client that negotiates the app contract, and kept for the web client", async () => {
    const rpc = (headers: Record<string, string>) =>
      fetch(`${s.base}/api/rpc`, {
        method: "POST",
        headers: { cookie: s.cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ method: "workspace.list", params: {} }),
      });
    expect((await rpc({ "x-shahi-api": String(SHAHI_API_VERSION) })).status).toBe(403);
    expect((await rpc({})).status).toBe(200);
  });
});

describe("hostile inputs are answered, not thrown", () => {

  test("a JSON body that is not an object is a 400", async () => {
    const res = await fetch(`${s.base}/api/panes/${encodeURIComponent(PANE)}/prompt`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  test("a malformed percent escape in a pane id is a 404", async () => {
    expect((await fetch(`${s.base}/api/panes/%zz`, { headers: { cookie: s.cookie } })).status).toBe(404);
  });

  test("a clientMessageId the size of a novel is refused before it is remembered", async () => {
    const res = await fetch(`${s.base}/api/panes/${encodeURIComponent(PANE)}/prompt`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", clientMessageId: "x".repeat(1_000) }),
    });
    expect(res.status).toBe(400);
  });

  test("NaN and negative limits on the transcript routes are clamped, not obeyed", async () => {
    for (const q of ["limit=NaN", "limit=-1", "limit=abc", "before=-5&limit=2"]) {
      const res = await fetch(`${s.base}/api/panes/${encodeURIComponent(PANE)}/transcript?${q}`, { headers: { cookie: s.cookie } });
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { lines: unknown[] }).lines)).toBe(true);
    }
  });
});

describe("what a client learns before it authenticates", () => {
  test("on a direct connection, the versions — the plugin's status line reads them over loopback", async () => {
    const info = (await (await fetch(`${s.base}/api/meta`)).json()) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(["api", "herdr", "serverId", "serverVersion"]);
  });

  test("and the relay's state, from this machine only", async () => {
    const r = await boot({ relay: true, allowedHosts: ["box.tailnet.ts.net"] });
    try {
      const local = (await (await fetch(`${r.base}/api/meta`)).json()) as Record<string, unknown>;
      expect(local.relay).toEqual({ url: "https://relay.test", connected: true });
      // The same request as a tailnet peer makes it, through the owner's
      // proxy: no relay line.
      const peer = await raw(r.base, "GET /api/meta HTTP/1.1\r\nHost: box.tailnet.ts.net\r\nX-Forwarded-For: 100.64.0.9\r\nConnection: close\r\n\r\n");
      expect(peer.status).toBe(200);
      expect(peer.text).not.toContain("relay.test");
    } finally {
      r.stop();
    }
  });
});


describe("writes and notification ownership", () => {
  const post = (path: string, body: unknown, cookie = s.cookie) => fetch(`${s.base}${path}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  async function pair(name: string) {
    const { secret } = await (await post("/api/pair", {})).json() as { secret: string };
    const response = await post("/api/pair/claim", { secret, deviceName: name });
    return { ...(await response.json() as { deviceId: string }), cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }

  test("two concurrent prompt requests deliver text and Enter once", async () => {
    const start = s.calls.length;
    const body = { text: "concurrent prompt", clientMessageId: "concurrent-review" };
    const responses = await Promise.all([post(`/api/panes/${PANE}/prompt`, body), post(`/api/panes/${PANE}/prompt`, body)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(s.calls.slice(start).filter(c => c.method === "pane.send_text")).toHaveLength(1);
    expect(s.calls.slice(start).filter(c => c.method === "pane.send_keys")).toHaveLength(1);
    expect((await post(`/api/panes/${PANE}/prompt`, { ...body, text: "changed" })).status).toBe(409);
  });

  // B2 in the pre-release bug hunt: herdr hangs up on a request over 1 MiB,
  // so a message has a limit, said in words before herdr is asked.
  test("a message over the size limit is a readable 413 and reaches nothing", async () => {
    const start = s.calls.length;
    const tooLong = await post(`/api/panes/${PANE}/prompt`, { text: "é".repeat(MAX_PROMPT_BYTES / 2 + 1), clientMessageId: "too-long" });
    expect(tooLong.status).toBe(413);
    expect(((await tooLong.json()) as { error: string }).error).toContain("too long");
    expect(s.calls.slice(start).filter(c => c.method.startsWith("pane.send"))).toHaveLength(0);
    // A long pasted log under it is sent as usual.
    const log = await post(`/api/panes/${PANE}/prompt`, { text: `${"at frame (file.ts:1:1)\n".repeat(400)}`, clientMessageId: "long-log" });
    expect(log.status).toBe(200);
  });

  test("retrying startup creates just one tab and agent", async () => {
    const start = s.calls.length;
    const body = { workspaceId: "w1", kind: "claude", clientRequestId: "start-review" };
    const results = await Promise.all([post("/api/agents/start", body), post("/api/agents/start", body)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(await results[0]!.json()).toEqual(await results[1]!.json());
    expect((await post("/api/agents/start", body)).status).toBe(200);
    expect(s.calls.slice(start).filter(c => c.method === "tab.create")).toHaveLength(1);
    expect(s.calls.slice(start).filter(c => c.method === "agent.start")).toHaveLength(1);
    expect((await post("/api/agents/start", { workspaceId: "w1", kind: "claude" })).status).toBe(400);
  });

  test("created workspaces and panes are immediately readable without waiting for mirror events", async () => {
    const fresh = await boot({ freshCreation: true });
    const headers = { cookie: fresh.cookie, "content-type": "application/json" };
    const create = async (path: string, body: unknown) => {
      const response = await fetch(fresh.base + path, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    try {
      const space = await create("/api/workspaces", { label: "new", cwd: "/tmp" });
      const tab = await create(`/api/workspaces/${space.workspaceId}/tabs`, { cwd: "/tmp" });
      expect((await fetch(`${fresh.base}/api/panes/${encodeURIComponent(tab.paneId)}`, { headers })).status).toBe(200);
      const started = await create("/api/agents/start", { workspaceId: space.workspaceId, kind: "claude", clientRequestId: "fresh-pane" });
      expect((await fetch(`${fresh.base}/api/panes/${encodeURIComponent(started.paneId)}`, { headers })).status).toBe(200);
    } finally { fresh.stop(); }
  });

  test("the semantic tab route validates its workspace and absolute directory", async () => {
    const start = s.calls.length;
    expect((await post("/api/workspaces/missing/tabs", {})).status).toBe(404);
    expect((await post("/api/workspaces/w1/tabs", { cwd: "~/project" })).status).toBe(400);
    expect(s.calls.slice(start).filter(c => c.method === "tab.create")).toHaveLength(0);
    const response = await post("/api/workspaces/w1/tabs", { label: "Shell", cwd: "/tmp" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tabId: "t1", paneId: PANE });
    expect(s.calls.slice(start).filter(c => c.method === "tab.create")).toHaveLength(1);
  });

  test("revocation removes both push channels only for that phone", async () => {
    const a = await pair("Revoke me");
    const b = await pair("Keep me");
    const baseline = s.push.count();
    expect((await post("/api/push/expo", { token: "ExpoPushToken[revoke]" }, a.cookie)).status).toBe(200);
    expect((await post("/api/push/subscribe", { endpoint: "https://push.example/revoke", keys: { p256dh: "x", auth: "y" } }, a.cookie)).status).toBe(200);
    expect((await post("/api/push/expo", { token: "ExpoPushToken[keep]" }, b.cookie)).status).toBe(200);
    expect(s.push.count()).toBe(baseline + 3);
    expect((await fetch(`${s.base}/api/devices/${a.deviceId}`, { method: "DELETE", headers: { cookie: s.cookie } })).status).toBe(200);
    expect(s.push.count()).toBe(baseline + 1);
    expect((await post("/api/push/expo", { token: "ExpoPushToken[revoke]" }, a.cookie)).status).toBe(401);
    await post("/api/auth/logout", {}, b.cookie);
    expect(s.push.count()).toBe(baseline);
  });

  test("a phone cannot unsubscribe a different owner's token", async () => {
    const a = await pair("Owner");
    const b = await pair("Other");
    const baseline = s.push.count();
    await post("/api/push/expo", { token: "ExpoPushToken[owned]" }, a.cookie);
    await post("/api/push/expo/unsubscribe", { token: "ExpoPushToken[owned]" }, b.cookie);
    expect(s.push.count()).toBe(baseline + 1);
    await post("/api/auth/logout", {}, a.cookie);
    expect(s.push.count()).toBe(baseline);
  });

  test("revocation while a push body arrives cannot resurrect its registration", async () => {
    const device = await pair("Slow registration");
    const baseline = s.push.count();
    let finish!: (body: unknown) => void;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const req = new Request(`${s.base}/api/push/expo`, { method: "POST", headers: { cookie: device.cookie } });
    Object.defineProperty(req, "json", { value: () => { reading(); return new Promise(resolve => { finish = resolve; }); } });
    const pending = s.dispatch(req, "slow-registration-test");
    await started;
    await fetch(`${s.base}/api/devices/${device.deviceId}`, { method: "DELETE", headers: { cookie: s.cookie } });
    finish({ token: "ExpoPushToken[slow]" });
    expect((await pending).status).toBe(401);
    expect(s.push.count()).toBe(baseline);
  });

  // Review finding F92: the multipart route checked the session only before
  // its body, which over SSH can take a long time to arrive.
  test("a phone revoked while its upload is arriving stores nothing", async () => {
    const device = await pair("Slow upload");
    let finish!: (form: FormData) => void;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const req = new Request(`${s.base}/api/uploads`, { method: "POST", headers: { cookie: device.cookie } });
    Object.defineProperty(req, "formData", { value: () => { reading(); return new Promise(resolve => { finish = resolve; }); } });
    const pending = s.dispatch(req, "slow-upload-test");
    await started;
    await fetch(`${s.base}/api/devices/${device.deviceId}`, { method: "DELETE", headers: { cookie: s.cookie } });
    const form = new FormData();
    form.set("file", new File(["after revocation"], "revoked-upload.txt"));
    finish(form);
    expect((await pending).status).toBe(401);
    const stored = existsSync(s.uploadDir) ? readdirSync(s.uploadDir) : [];
    expect(stored.filter(name => name.includes("revoked-upload"))).toEqual([]);
  });

  // Review finding F93: a failure that never reached herdr was replayed to the
  // phone's retry, which reuses the message id, for ten minutes.
  test("a message sent while herdr was down goes through when retried after herdr is back", async () => {
    const body = { text: "sent during a restart", clientMessageId: "restart-review" };
    herdrDown = await noHerdrSocket();
    try {
      expect((await post(`/api/panes/${PANE}/prompt`, body)).status).toBe(500);
    } finally { herdrDown = null; }
    const start = s.calls.length;
    const retried = await post(`/api/panes/${PANE}/prompt`, body);
    expect(retried.status).toBe(200);
    expect(s.calls.slice(start).filter(c => c.method === "pane.send_text")).toHaveLength(1);
    // Delivered now, so a further retry gets this receipt rather than a second message.
    expect(await (await post(`/api/panes/${PANE}/prompt`, body)).json()).toEqual(await retried.json());
    expect(s.calls.slice(start).filter(c => c.method === "pane.send_text")).toHaveLength(1);
  });

  test("a new agent that could not be started while herdr was down starts on the retry", async () => {
    const body = { workspaceId: "w1", kind: "claude", clientRequestId: "start-during-restart" };
    herdrDown = await noHerdrSocket();
    try {
      expect((await post("/api/agents/start", body)).status).toBe(500);
    } finally { herdrDown = null; }
    const start = s.calls.length;
    expect((await post("/api/agents/start", body)).status).toBe(200);
    expect(s.calls.slice(start).filter(c => c.method === "tab.create")).toHaveLength(1);
  });
});

describe("authenticated recovery across API generations", () => {
  test("a revoked device cannot finish a pending update or access recovery", async () => {
    const root = join(scratch, "recovery-revocation");
    atomicJson(join(root, "status.json"), { managed: true, phase: "idle", channel: "stable", current: "0.3.1" });
    const box = await boot({ recovery: true, recoveryRoot: root });
    try {
      const post = (path: string, body: unknown, cookie = box.cookie) => fetch(box.base + path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const { secret } = await (await post("/api/pair", {})).json() as { secret: string };
      const claimed = await post("/api/pair/claim", { secret, deviceName: "Security fixture" });
      const { deviceId } = await claimed.json() as { deviceId: string };
      const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie, "x-shahi-control": "1", "x-shahi-api": "99" };
      let finish!: (body: unknown) => void, reading!: () => void;
      const started = new Promise<void>(resolve => { reading = resolve; });
      const req = new Request(`${box.base}/api/control/update`, { method: "POST", headers });
      Object.defineProperty(req, "json", { value: () => { reading(); return new Promise(resolve => { finish = resolve; }); } });
      const pending = box.dispatch(req, "slow-update-security-test");
      await started;
      expect((await fetch(`${box.base}/api/devices/${deviceId}`, { method: "DELETE", headers: { cookie: box.cookie } })).status).toBe(200);
      finish({ action: "install" });
      expect((await pending).status).toBe(401);
      expect(existsSync(join(root, "request.json"))).toBe(false);
      expect((await fetch(`${box.base}/api/control/handshake`, { headers })).status).toBe(401);
      expect((await fetch(`${box.base}/api/control/update`, { method: "POST", headers, body: '{"action":"install"}' })).status).toBe(401);
    } finally { box.stop(); }
  });

  test("an API mismatch and offline herdr do not hide recovery or revoke pairing", async () => {
    const box = await boot({ recovery: true });
    try {
      const h = { cookie: box.cookie, "x-shahi-api": "99", "x-shahi-control": "1" };
      expect((await fetch(`${box.base}/api/session`, { headers: h })).status).toBe(426);
      const reply = await fetch(`${box.base}/api/control/handshake`, { headers: h });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ control: 1, serverId: "test-server", backend: { state: "offline" } });
      expect((await fetch(`${box.base}/api/control/handshake`, { headers: { "x-shahi-control": "1" } })).status).toBe(401);
      expect((await fetch(`${box.base}/api/control/handshake`, { headers: { cookie: box.cookie } })).status).toBe(426);
      expect((await fetch(`${box.base}/api/session`, { headers: { cookie: box.cookie, "x-shahi-api": "5" } })).status).toBe(503);
      expect((await fetch(`${box.base}/api/devices`, { headers: { cookie: box.cookie, "x-shahi-api": "5" } })).status).toBe(200);
      expect((await fetch(`${box.base}/api/control/update`, { method: "POST", headers: { ...h, origin: "https://evil.example", "content-type": "application/json" }, body: '{"action":"install"}' })).status).toBe(403);
      const relay = await box.dispatch(new Request(`${box.base}/api/control/handshake`, { headers: h }), "device-test");
      expect(relay?.status).toBe(200);
      const meta = await box.dispatch(new Request(`${box.base}/api/meta`), "device-test");
      expect(await meta?.json()).toEqual({ serverId: "test-server", control: 1, api: { min: 5, max: 5 } });
    } finally { box.stop(); }
  });
});


test("authenticated file ranges preserve bytes and detect a changing download", async () => {
  const path = join(scratch, "range-sample.pdf");
  writeFileSync(path, "0123456789");
  const url = `${s.base}/api/file?path=${encodeURIComponent(path)}`;
  const denied = await fetch(url, { headers: { range: "bytes=0-3" } });
  expect(denied.status).toBe(401);
  const first = await fetch(url, { headers: { cookie: s.cookie, range: "bytes=0-3" } });
  expect(first.status).toBe(206);
  expect(first.headers.get("content-range")).toBe("bytes 0-3/10");
  expect(await first.text()).toBe("0123");
  const version = first.headers.get("x-shahi-file-version")!;
  const tail = await fetch(url, { headers: { cookie: s.cookie, range: "bytes=4-20", "x-shahi-file-version": version } });
  expect(tail.status).toBe(206); expect(await tail.text()).toBe("456789");
  const invalid = await fetch(url, { headers: { cookie: s.cookie, range: "bytes=50-60" } });
  expect(invalid.status).toBe(416);
  writeFileSync(path, "different-file-content");
  const changed = await fetch(url, { headers: { cookie: s.cookie, range: "bytes=4-8", "x-shahi-file-version": version } });
  expect(changed.status).toBe(409);
});

// September 2026 pre-release bug hunt: only `bytes=<first>-<last>` was served,
// and every other form answered 416 without the file's size while the route
// advertised Accept-Ranges, so `curl -C -` could not resume a download.
test("open-ended, suffix and upper-case byte ranges are served, and ranges it does not handle get the whole file", async () => {
  const path = join(scratch, "ranges.txt");
  writeFileSync(path, "0123456789");
  const get = async (range: string) => {
    const res = await fetch(`${s.base}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie: s.cookie, range } });
    return { range, status: res.status, contentRange: res.headers.get("content-range"), body: await res.text() };
  };
  expect(await get("bytes=4-")).toEqual({ range: "bytes=4-", status: 206, contentRange: "bytes 4-9/10", body: "456789" });
  expect(await get("bytes=-2")).toEqual({ range: "bytes=-2", status: 206, contentRange: "bytes 8-9/10", body: "89" });
  expect(await get("bytes=-50")).toEqual({ range: "bytes=-50", status: 206, contentRange: "bytes 0-9/10", body: "0123456789" });
  expect(await get("BYTES=0-1")).toEqual({ range: "BYTES=0-1", status: 206, contentRange: "bytes 0-1/10", body: "01" });
  // Another unit, several ranges, or a malformed one: ignored, as RFC 9110 allows.
  for (const range of ["items=0-1", "bytes=0-1,3-4", "bytes=5-2", "bytes=x-y"]) {
    expect(await get(range)).toEqual({ range, status: 200, contentRange: null, body: "0123456789" });
  }
  // Past the end, or an empty suffix: 416, saying how long the file is.
  for (const range of ["bytes=10-", "bytes=50-60", "bytes=-0"]) {
    expect(await get(range)).toMatchObject({ range, status: 416, contentRange: "bytes */10" });
  }
});

// September 2026 pre-release bug hunt: reading a FIFO waits for a writer for
// ever, and each request held one of the two file-work slots, so two taps on a
// named pipe made every later file view and upload answer 503 until restart.
test("two requests for a named pipe leave file views and uploads answering", async () => {
  const app = await boot();
  try {
    const fifo = join(scratch, "stuck.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const file = (path: string) => fetch(`${app.base}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie: app.cookie }, signal: AbortSignal.timeout(1_500) });
    const pipes = await Promise.all([file(fifo), file(fifo)].map((p) => p.then((r) => r.status, () => "timed out")));
    expect(pipes).toEqual([400, 400]);
    expect((await fetch(`${app.base}/api/uploads/limits`, { headers: { cookie: app.cookie } })).status).toBe(200);
    writeFileSync(join(scratch, "after-the-pipe.txt"), "still here");
    expect((await file(join(scratch, "after-the-pipe.txt"))).status).toBe(200);
  } finally { app.stop(); }
});

// September 2026 pre-release bug hunt: a folder inside home was refused as
// "<folder> is outside the home directory", and the web viewer shows the
// server's words as they stand.
test("a folder, a file outside home and a missing file are each refused for what they are", async () => {
  const refusal = async (path: string) => {
    const res = await fetch(`${s.base}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie: s.cookie } });
    return { status: res.status, ...(await res.json() as { error: string; code?: string }) };
  };
  expect(await refusal(scratch)).toEqual({ status: 400, code: "not_a_file", error: "That is a folder, not a file." });
  expect(await refusal("/etc/hosts")).toMatchObject({ status: 403, code: "outside_roots", error: expect.stringContaining("outside your home folder") });
  expect(await refusal(join(scratch, "never-written.txt"))).toMatchObject({ status: 404, code: "not_found" });
  // The relay's own 413 means "this computer needs an update"; this one is
  // final, and says so with a code the clients can tell apart.
  const huge = join(scratch, "huge.log");
  writeFileSync(huge, "");
  truncateSync(huge, 26 * 1024 * 1024);
  expect(await refusal(huge)).toMatchObject({ status: 413, code: "file_too_large", error: expect.stringContaining("over 25 MB") });
});

// Review finding F38: a header value above U+00FF threw while the response was
// built, and the route answered "cannot read that file" for a file that was there.
test("a file named in Arabic, with an emoji, or by a macOS screenshot opens and keeps its name", async () => {
  const names = ["صورة.png", "Screenshot 2026-09-22 at 10.15.32\u202FAM.png", "notes \u{1F600}.txt", "a \"quoted\" name (1).txt", "plain.txt"];
  for (const name of names) {
    writeFileSync(join(scratch, name), "contents");
    for (const download of [false, true]) {
      const res = await fetch(`${s.base}/api/file?path=${encodeURIComponent(join(scratch, name))}${download ? "&download=1" : ""}`, { headers: { cookie: s.cookie } });
      expect({ name, status: res.status }).toEqual({ name, status: 200 });
      expect(await res.text()).toBe("contents");
      const header = res.headers.get("content-disposition")!;
      expect(header).toStartWith(`${download ? "attachment" : "inline"}; filename="`);
      // The ASCII fallback stays a well-formed quoted string.
      expect(header.match(/filename="([^"]*)";/)![1]).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeURIComponent(header.match(/filename\*=UTF-8''([^;]+)$/)![1]!)).toBe(name);
    }
  }
});


test("chunk upload routes enforce authentication, body bounds and session ownership", async () => {
  const app = await boot();
  try {
    const path = app.base + "/api/uploads/transfers/http-upload-00000001";
    expect((await fetch(app.base + "/api/uploads/limits")).status).toBe(401);
    const headers = { cookie: app.cookie, "content-type": "application/json" };
    expect((await fetch(app.base + "/api/uploads/limits", { headers })).status).toBe(200);
    expect((await fetch(path, { method: "PUT", headers, body: JSON.stringify({ name: "sample", type: "", size: 1 }) })).status).toBe(200);
    expect((await fetch(path + "/chunk", { method: "PUT", headers: { ...headers, "x-upload-offset": "0" }, body: new Uint8Array(65537) })).status).toBe(413);
    expect((await fetch(path + "/chunk", { method: "PUT", headers: { ...headers, "x-upload-offset": "0" }, body: new Uint8Array([42]) })).status).toBe(200);
    const login = await fetch(app.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }) });
    const other = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(path, { headers: { cookie: other } })).status).toBe(404);
    expect((await fetch(path, { method: "DELETE", headers })).status).toBe(200);
  } finally { app.stop(); }
});

// September 2026 pre-release bug hunt: the multipart route divided the binary
// limit by a decimal million, and the native Attach sheet showed its words over
// SSH as they stood: "file is 34.6MB, over the 33.554432MB limit".
test("a multipart upload over the limit is told files can be up to 32 MB, not 33.554432MB", async () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(33 * 1024 * 1024)], "clip.mov"));
  const res = await fetch(`${s.base}/api/uploads`, { method: "POST", headers: { cookie: s.cookie }, body: form });
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "Files can be up to 32 MB" });
});

// September 2026 pre-release bug hunt: only a transfer's owner or the
// 10-minute idle sweep reclaimed an unfinished upload, and a revoked phone or
// a dead cookie can do neither, so two such phones held both upload slots and
// every other device was told "Another file is uploading" for ten minutes.
test("phones revoked or signed out mid-upload leave the upload slots to everyone else", async () => {
  const app = await boot();
  try {
    const post = (path: string, body: unknown, cookie = app.cookie) => fetch(`${app.base}${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const pair = async (name: string) => {
      const { secret } = await (await post("/api/pair", {})).json() as { secret: string };
      const claimed = await post("/api/pair/claim", { secret, deviceName: name });
      return { ...(await claimed.json() as { deviceId: string }), cookie: claimed.headers.get("set-cookie")!.split(";")[0]! };
    };
    const transfer = (id: string) => `${app.base}/api/uploads/transfers/${id}`;
    const begin = (cookie: string, id: string) => fetch(transfer(id), {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "photo.jpg", type: "image/jpeg", size: 1024 * 1024 }),
    }).then((r) => r.status);
    const revoked = await pair("Revoked mid-upload");
    const signedOut = await pair("Signed out mid-upload");
    expect(await begin(revoked.cookie, "revoked-mid-upload-01")).toBe(200);
    expect((await fetch(`${transfer("revoked-mid-upload-01")}/chunk`, {
      method: "PUT", headers: { cookie: revoked.cookie, "x-upload-offset": "0" }, body: new Uint8Array(4096),
    })).status).toBe(200);
    expect(await begin(signedOut.cookie, "signed-out-mid-upload")).toBe(200);
    // Two unfinished transfers fill the computer.
    expect(await begin(app.cookie, "passcode-upload-0001")).toBe(429);

    expect((await fetch(`${app.base}/api/devices/${revoked.deviceId}`, { method: "DELETE", headers: { cookie: app.cookie } })).status).toBe(200);
    expect((await post("/api/auth/logout", {}, signedOut.cookie)).status).toBe(200);

    expect(await begin(app.cookie, "passcode-upload-0001")).toBe(200);
    const left = readdirSync(join(app.uploadDir, ".transfers"));
    expect(left.filter((name) => name.startsWith("revoked-") || name.startsWith("signed-out-"))).toEqual([]);
  } finally { app.stop(); }
});

// Text then Enter at a menu picks the lit row for the person: measured on
// Claude Code's Bash permission menu, "no" + Enter ran the command. The route
// refuses with a code and a message any client can show as it stands.
describe("a message to an agent waiting on a menu", () => {
  let app: Booted;
  beforeAll(async () => {
    agentStatus = "blocked";
    app = await boot();
  });
  afterAll(() => {
    app.stop();
    agentStatus = null;
  });
  const send = (text: string, clientMessageId: string) =>
    fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}/prompt`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify({ text, clientMessageId }),
    });
  const typed = (from: number) => app.calls.slice(from).filter((c) => c.method.startsWith("pane.send"));

  test("is a 409 prompt_open that says what to use instead, and types nothing", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__claude-bash__text.txt"), "utf8");
    const before = app.calls.length;
    const res = await send("no, use yarn instead", "menu-open-1");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("prompt_open");
    expect(body.error).toContain("option buttons");
    expect(typed(before)).toEqual([]);
  });

  test("is typed when the question asks for text", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__claude-ask-type__text.txt"), "utf8");
    const before = app.calls.length;
    expect((await send("blue", "menu-open-2")).status).toBe(200);
    expect(typed(before).map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  });
});

// Pre-release bug hunt, B9: herdr silently uses $HOME for a folder that is
// not there, so a project deleted after its space was made got an agent, in
// bypass-permissions mode, in the home directory, under a card naming the
// project. Each create route now says so instead, before asking herdr.
describe("making something in a folder that is not there", () => {
  const post = (path: string, body: unknown) =>
    fetch(`${s.base}${path}`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const creates = (from: number) =>
    s.calls.slice(from).filter((c) => ["workspace.create", "tab.create", "agent.start"].includes(c.method));
  const routes: [string, Record<string, unknown>][] = [
    ["/api/workspaces", { label: "gone" }],
    ["/api/workspaces/w1/tabs", { label: "gone" }],
    ["/api/agents/start", { workspaceId: "w1", kind: "claude", clientRequestId: "missing-folder" }],
  ];

  test.each(routes)("%s is refused in words, and herdr is asked nothing", async (path, body) => {
    const before = s.calls.length;
    const res = await post(path, { ...body, cwd: join(scratch, "deleted-project") });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("That folder does not exist on this computer.");
    expect(creates(before)).toEqual([]);
  });

  test.each(routes)("%s refuses a file", async (path, body) => {
    const file = join(scratch, "not-a-folder.txt");
    writeFileSync(file, "a file");
    const before = s.calls.length;
    const res = await post(path, { ...body, cwd: file, clientRequestId: "file-folder" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("That path is a file, not a folder.");
    expect(creates(before)).toEqual([]);
  });

  test("an agent refused for a deleted folder starts on the retry once the folder is back", async () => {
    const project = join(scratch, "renamed-project");
    const body = { workspaceId: "w1", kind: "claude", clientRequestId: "folder-comes-back", cwd: project };
    expect((await post("/api/agents/start", body)).status).toBe(400);
    mkdirSync(project);
    const before = s.calls.length;
    expect((await post("/api/agents/start", body)).status).toBe(200);
    expect(creates(before).map((c) => c.method)).toEqual(["tab.create", "agent.start"]);
  });
});

// Pre-release bug hunt, B43: herdr gives a closed space's id to the next space
// after a restart, and the retry record does not survive one, so an uncertain
// start retried across a restart made its agent in the new space.
describe("starting an agent in a space that has closed", () => {
  const post = (body: unknown) =>
    fetch(`${s.base}/api/agents/start`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const tabs = (from: number) => s.calls.slice(from).filter((c) => c.method === "tab.create");

  test("is a 404 when no space has its id", async () => {
    const before = s.calls.length;
    const res = await post({ workspaceId: "w404", kind: "claude", clientRequestId: "closed-space" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("That space is no longer open on this computer.");
    expect(tabs(before)).toEqual([]);
  });

  test("is a 409 workspace_changed when another space now has its id", async () => {
    const before = s.calls.length;
    const res = await post({ workspaceId: "w1", workspaceLabel: "projA", kind: "claude", clientRequestId: "replaced-space" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("workspace_changed");
    expect(tabs(before)).toEqual([]);
  });

  test("goes ahead with the name the space still has, or with none from an older client", async () => {
    const before = s.calls.length;
    expect((await post({ workspaceId: "w1", workspaceLabel: "one", kind: "claude", clientRequestId: "same-space" })).status).toBe(200);
    expect((await post({ workspaceId: "w1", kind: "claude", clientRequestId: "older-client" })).status).toBe(200);
    expect(tabs(before)).toHaveLength(2);
  });
});

// Pre-release bug hunt, B81: a failed start left an empty tab behind for
// every attempt, surviving herdr restarts, and the phone showed herdr's raw
// "agent.get failed [agent_not_found]".
describe("an agent that cannot start", () => {
  const post = (body: unknown) =>
    fetch(`${s.base}/api/agents/start`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const methods = (from: number) => s.calls.slice(from).map((c) => c.method).filter((m) => m.startsWith("tab.") || m.startsWith("agent."));

  test("is refused before a tab is made when herdr does not know the kind", async () => {
    const before = s.calls.length;
    const res = await post({ workspaceId: "w1", kind: "not-an-agent", clientRequestId: "unknown-kind" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("does not know how to start");
    expect(methods(before)).toEqual([]);
  });

  test("closes its tab when it exits while starting, says so in words, and can be tried again", async () => {
    agentExitsWhileStarting = true;
    try {
      const body = { workspaceId: "w1", kind: "claude", clientRequestId: "exits-while-starting" };
      const before = s.calls.length;
      const res = await post(body);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("exited while it was starting");
      expect(error).not.toContain("agent_not_found");
      expect(methods(before)).toEqual(["tab.create", "agent.start", "agent.get", "tab.close"]);
      expect(s.calls.find((c, i) => i >= before && c.method === "tab.close")?.params).toEqual({ tab_id: "t1" });
      // Nothing was left behind, so the same request runs again rather than
      // being handed the failure for ten minutes.
      const retry = s.calls.length;
      expect((await post(body)).status).toBe(400);
      expect(methods(retry)).toContain("tab.create");
    } finally {
      agentExitsWhileStarting = false;
    }
  });
});

// Pre-release bug hunt, B6: nothing ordered two phones' writes to one pane,
// so one's input landed inside the other's read-to-Enter window. Two messages
// were submitted as one line, and a key-bar Up moved the cursor before a
// message's Enter, which then chose a menu row. Each phone was told 200.
describe("writes to one pane from two phones", () => {
  const post = (sub: string, body: unknown) =>
    fetch(`${s.base}/api/panes/${encodeURIComponent(PANE)}${sub}`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const sent = (from: number) =>
    s.calls.slice(from).filter((c) => c.method.startsWith("pane.send")).map((c) => {
      const params = c.params as { text?: string; keys?: string[] };
      return c.method === "pane.send_text" ? `text:${params.text}` : `keys:${params.keys!.join("+")}`;
    });

  test("two messages are each typed and submitted before the next begins", async () => {
    const before = s.calls.length;
    const [a, b] = await Promise.all([
      post("/prompt", { text: "alpha", clientMessageId: "two-phones-a" }),
      post("/prompt", { text: "bravo", clientMessageId: "two-phones-b" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sent(before)).toEqual(["text:alpha", "keys:Enter", "text:bravo", "keys:Enter"]);
  });

  // The Up landed between the answer's read and its Enter, which then
  // confirmed "No, exit" and quit the agent.
  test("a key pressed while an answer is on its way waits for it", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__trust-folder__text.txt"), "utf8");
    const before = s.calls.length;
    const answer = post("/answer", { index: 2, label: "Yes, I trust this folder" });
    const key = post("/keys", { keys: ["Up"] });
    expect([(await answer).status, (await key).status]).toEqual([200, 200]);
    expect(sent(before)).toEqual(["keys:Enter", "keys:Up"]);
  });

  test("a key pressed while a message is being typed waits for its Enter", async () => {
    const before = s.calls.length;
    const message = post("/prompt", { text: "please use blue", clientMessageId: "key-during-message" });
    // Well inside the message's 200ms pause between its text and its Enter.
    await Bun.sleep(60);
    const key = post("/keys", { keys: ["Up"] });
    expect([(await message).status, (await key).status]).toEqual([200, 200]);
    expect(sent(before)).toEqual(["text:please use blue", "keys:Enter", "keys:Up"]);
  });
});

// Pre-release bug hunt, B5 and B46: two phones answering one prompt both
// pressed "1" before the agent repainted, approving the next prompt; and a
// card left from one prompt approved an identical one asked after it.
describe("answering a prompt another phone has answered", () => {
  let app: Booted;
  beforeAll(async () => {
    agentStatus = "blocked";
    app = await boot();
  });
  afterAll(() => {
    app.stop();
    agentStatus = null;
    afterKeys = "";
  });
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
  const BASH = fixture("blocked__claude-bash__text.txt");
  const post = (body: unknown) =>
    fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}/answer`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const pressed = (from: number) => app.calls.slice(from).filter((c) => c.method === "pane.send_keys");
  /**
   * The card a phone draws: the prompt as the pane route sends it. The route
   * serves the poller's last frame, so each test asks a fresh server.
   */
  async function card() {
    app.stop();
    app = await boot();
    const res = await fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}`, { headers: { cookie: app.cookie } });
    const { frame } = (await res.json()) as { frame: { prompt: { question: string; context?: string[]; promptId?: string } } };
    return { index: 1, label: "Yes", question: frame.prompt.question, context: frame.prompt.context, promptId: frame.prompt.promptId };
  }

  test("presses one key between two phones answering at once", async () => {
    screen = BASH;
    afterKeys = BASH.replace("   touch probe.txt", "   touch probe-2.txt");
    const shown = await card();
    const before = app.calls.length;
    const responses = await Promise.all([post(shown), post(shown)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(pressed(before)).toHaveLength(1);
  });

  test("a card from before the agent asked the same thing again is a 409 prompt_gone", async () => {
    screen = BASH;
    afterKeys = "✻ Working…";
    const shown = await card();
    expect(shown.promptId).toBeString();
    expect((await post(shown)).status).toBe(200);
    // The agent asks for the same command again; the other phone's card is the old one.
    screen = BASH;
    const before = app.calls.length;
    const stale = await post(shown);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("prompt_gone");
    expect(pressed(before)).toEqual([]);
  });

  test("refuses a prompt id that is not one", async () => {
    screen = BASH;
    const before = app.calls.length;
    expect((await post({ index: 1, label: "Yes", promptId: 7 })).status).toBe(400);
    expect((await post({ index: 1, label: "Yes", promptId: "x".repeat(65) })).status).toBe(400);
    expect(pressed(before)).toEqual([]);
  });
});

// Pre-release bug hunt, B4: a message sent in an agent's first seconds, while
// the mirror still listed the pane as a shell, was typed onto the
// folder-trust menu with no screen read, and its Enter chose "No, exit".
describe("a message to an agent the mirror has not recognised yet", () => {
  let app: Booted;
  beforeAll(async () => {
    unmirroredAgent = "unknown";
    app = await boot();
  });
  afterAll(() => {
    app.stop();
    unmirroredAgent = null;
  });

  test("is refused at its folder-trust menu, and nothing is typed", async () => {
    screen = readFileSync(join(import.meta.dir, "..", "fixtures", "blocked__trust-folder__text.txt"), "utf8");
    const before = app.calls.length;
    const res = await fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}/prompt`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify({ text: "please fix the tests", clientMessageId: "unmirrored-trust" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("prompt_open");
    expect(app.calls.slice(before).filter((c) => c.method.startsWith("pane.send") || c.method === "agent.prompt")).toEqual([]);
  });
});

// Every Claude permission menu offers "1. Yes"; a stale card must not approve
// the next request just because its option reads the same.
describe("answering from a card drawn from another question", () => {
  const post = (body: unknown) =>
    fetch(`${s.base}/api/panes/${encodeURIComponent(PANE)}/answer`, {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
  const pressed = (from: number) => s.calls.slice(from).filter((c) => c.method === "pane.send_keys");

  test("is a 409 prompt_changed with nothing pressed", async () => {
    screen = fixture("blocked__claude-bash-rm__text.txt");
    const before = s.calls.length;
    const res = await post({
      index: 1,
      label: "Yes",
      question: "Do you want to proceed?",
      context: ["Bash command", "touch probe.txt\nCreate empty probe file"],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("prompt_changed");
    expect(pressed(before)).toEqual([]);
  });

  test("refuses a question or context of the wrong shape", async () => {
    screen = fixture("blocked__claude-bash__text.txt");
    const before = s.calls.length;
    expect((await post({ index: 1, label: "Yes", question: 7 })).status).toBe(400);
    expect((await post({ index: 1, label: "Yes", question: "Do you want to proceed?", context: "touch" })).status).toBe(400);
    expect((await post({ index: 1, label: "Yes", question: "Do you want to proceed?", context: [1] })).status).toBe(400);
    expect(pressed(before)).toEqual([]);
  });
});

// herdr keeps a pane's agent_session after its agent is gone: restarted with
// resume off, or with the agent missing from its PATH, the pane comes back as
// a shell still naming the old conversation. The reader showed that dead
// conversation with "Reply to this agent…", and the reply ran in the shell
// (pre-release bug hunt). The transcript lookup is faked for that one session
// id only, so the finding is real and every other test reads as before.
describe("a pane herdr restored as a shell, still naming its dead agent's session", () => {
  const dead = "0f4d6c1e-7a52-4c1b-9d3e-5b8a2f6c9e10";
  const dir = mkdtempSync(join(tmpdir(), "shahi-dead-agent-"));
  const path = join(dir, `${dead}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-20T02:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Shall I roll back prod?" }] } }) + "\n");
  let app: Booted;
  const get = (route: string) => fetch(`${app.base}${route}`, { headers: { cookie: app.cookie, "x-shahi-api": String(SHAHI_API_VERSION) } });

  beforeAll(async () => {
    const real = { ...(await import("./session-log")) };
    mock.module("./session-log", () => ({
      ...real,
      // The reader finds a transcript by path and reads it from there, so
      // finding it is the one step to fake.
      findTranscript: async (id: string) => (id === dead ? path : real.findTranscript(id)),
    }));
    occupant = { agent: null, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: dead } };
    app = await boot();
  });
  afterAll(() => {
    app.stop();
    occupant = {};
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves no transcript and no preview of the conversation that ended", async () => {
    expect((await get(`/api/panes/${encodeURIComponent(PANE)}/session`)).status).toBe(404);
    const session = (await (await get("/api/session")).json()) as { panes: { paneId: string; preview: string | null; isAgent: boolean }[] };
    expect(session.panes.find((p) => p.paneId === PANE)).toMatchObject({ isAgent: false, preview: null });
  });

  test("while the same session is read for as long as its agent runs", async () => {
    occupant = { agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: dead } };
    const live = await boot();
    try {
      const res = await fetch(`${live.base}/api/panes/${encodeURIComponent(PANE)}/session`, { headers: { cookie: live.cookie, "x-shahi-api": String(SHAHI_API_VERSION) } });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain("Shall I roll back prod?");
    } finally { live.stop(); }
  });
});

// herdr reuses pane ids: after a restart a new space takes the id of the
// highest one closed before it. The pre-release bug hunt kept a draft's send
// uncertain, closed that space, restarted herdr (which restarts the sidecar,
// emptying its record of delivered operations) and made a new space: the
// retry went to the new shell under the old id and ran there as a command.
describe("a write meant for a pane's previous program", () => {
  let app: Booted;
  beforeAll(async () => {
    occupant = { terminal_id: "term_first" };
    app = await boot();
  });
  afterAll(() => {
    app.stop();
    occupant = {};
  });
  const post = (sub: string, body: unknown) =>
    fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}${sub}`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) },
      body: JSON.stringify(body),
    });
  const occupantNow = async () => {
    const session = (await (await fetch(`${app.base}/api/session`, { headers: { cookie: app.cookie, "x-shahi-api": String(SHAHI_API_VERSION) } })).json()) as { panes: { paneId: string; instanceId?: string }[] };
    return session.panes.find((p) => p.paneId === PANE)?.instanceId;
  };
  const writes = (from: number) => app.calls.slice(from).filter((c) => c.method.startsWith("pane.send") || c.method === "agent.prompt");

  test("a retried send is refused, not typed into the program that took the pane id", async () => {
    const first = await occupantNow();
    expect(first).toBe("term_first");
    const detail = (await (await fetch(`${app.base}/api/panes/${encodeURIComponent(PANE)}`, { headers: { cookie: app.cookie } })).json()) as { instanceId?: string };
    expect(detail.instanceId).toBe(first);
    expect((await post("/prompt", { text: "delivered before", clientMessageId: "before-restart", instanceId: first })).status).toBe(200);

    // The space closed and a new one took its ids.
    app.herdr.panes[0]!.terminal_id = "term_second";
    await app.store.resync();
    expect(await occupantNow()).toBe("term_second");

    const before = app.calls.length;
    const refused = await post("/prompt", { text: "echo QA-RETRY-LANDED", clientMessageId: "lost-response", instanceId: first });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("pane_replaced");
    expect((await post("/keys", { keys: ["Enter"], instanceId: first })).status).toBe(409);
    expect((await post("/answer", { index: 1, label: "Yes", instanceId: first })).status).toBe(409);
    expect(writes(before)).toEqual([]);

    // A message delivered before the pane changed hands still gets its receipt.
    expect((await post("/prompt", { text: "delivered before", clientMessageId: "before-restart", instanceId: first })).status).toBe(200);
    expect(writes(before)).toEqual([]);
  });

  test("while a write for the program there now, and one from an app that names no occupant, go through", async () => {
    const now = await occupantNow();
    let before = app.calls.length;
    expect((await post("/prompt", { text: "for the new one", clientMessageId: "current", instanceId: now })).status).toBe(200);
    expect(writes(before).length).toBeGreaterThan(0);
    before = app.calls.length;
    expect((await post("/prompt", { text: "from an older app", clientMessageId: "older-app" })).status).toBe(200);
    expect(writes(before).length).toBeGreaterThan(0);
    expect((await post("/prompt", { text: "x", clientMessageId: "bad", instanceId: 7 })).status).toBe(400);
  });

  test("the refusal reached nothing, so the same message id can be sent again once meant for the program there now", async () => {
    const now = await occupantNow();
    expect((await post("/prompt", { text: "again", clientMessageId: "refused-then-meant", instanceId: "term_first" })).status).toBe(409);
    expect((await post("/prompt", { text: "again", clientMessageId: "refused-then-meant", instanceId: now })).status).toBe(200);
  });
});
