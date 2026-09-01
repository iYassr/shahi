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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { Devices, Pairing } from "./pairing";
import type { Config } from "./config";
import type { HerdrClient } from "./herdr-client";
import { createServer } from "./http";
import { Poller } from "./poller";
import { PushService } from "./push";
import { SessionStore } from "./state";
import { TranscriptStore } from "./transcript";

const PANE = "w1:p1";
const PASSCODE = "2468";

/** Enough of herdr for the routes under test; anything else is refused. */
function fakeHerdr(calls: { method: string; params: unknown }[]): HerdrClient {
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
  };
  const snapshot = {
    version: "0.8.2",
    protocol: 20,
    workspaces: [{ workspace_id: "w1", label: "one", agent_status: "unknown", pane_count: 1, tab_count: 1, focused: true }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1, agent_status: "unknown", pane_count: 1, focused: true }],
    panes: [pane],
    agents: [],
    layouts: [],
    focused_pane_id: PANE,
  };
  return {
    rpc: async (method: string, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "session.snapshot":
          return { snapshot };
        case "pane.send_keys":
        case "pane.send_text":
          return {};
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
  stop: () => void;
}

let passcodeHash = "";
const scratch = mkdtempSync(join(tmpdir(), "shahi-http-"));
let booted = 0;

async function boot({ sessionTtlMs = 60_000, heartbeatMs = 20_000 } = {}): Promise<Booted> {
  const calls: Booted["calls"] = [];
  const client = fakeHerdr(calls);
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
  const server = createServer(
    { config, auth, client, store, poller, transcript, push, pairing, devices, serverId: "test-server" },
    { heartbeatMs },
  );
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { base, cookie, calls, stop: () => server.stop(true) };
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
    expect(await socket(s.base, {})).toMatchObject({ open: false });
  });

  test("every response says nosniff, no frames, no referrer", async () => {
    const res = await fetch(`${s.base}/api/meta`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("the routes anyone can reach are rate limited by address", () => {
  test("a flood from one address is refused with retry-after; another address is not", async () => {
    // The peer is loopback, so x-forwarded-for is believed — which also keeps
    // this flood from counting against the rest of the suite.
    const from = (ip: string) => fetch(`${s.base}/api/meta`, { headers: { "x-forwarded-for": ip } });
    let refused: Response | null = null;
    for (let i = 0; i < 40 && !refused; i++) {
      const res = await from("203.0.113.9");
      if (res.status === 429) refused = res;
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await from("203.0.113.10")).status).toBe(200);
    // The gated routes are not behind the limiter: the flood above did not
    // touch them.
    expect((await fetch(`${s.base}/api/session`, { headers: { cookie: s.cookie, "x-forwarded-for": "203.0.113.9" } })).status).toBe(200);
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
