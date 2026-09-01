/**
 * The box's relay client, against a fake relay and a fake phone.
 *
 * The relay here is the protocol in `docs/relay.md` reduced to what a test
 * needs: it challenges boxes and checks their signatures, numbers phones into
 * links, prefixes and strips the link number, and closes what it is told to
 * close. The phone is the other end of `shared/src/e2e.ts`: it says hello,
 * derives the session, and seals requests. Between them is the real
 * `RelayClient` on the real `createServer`, with only herdr faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  BOX_AUTH_PREFIX,
  LINK_PREFIX_BYTES,
  RELAY_CLOSE,
  RELAY_PROTOCOL,
  SHAHI_API_VERSION,
  type BoxHello,
  type BoxToPhone,
  type BoxToRelay,
  type ClaimResult,
  type PhoneHello,
  type PhoneToBox,
  type RelayRequest,
  type RelayResponse,
  type SocketMessage,
} from "@shahi/shared";
import { clientSession, ephemeral, open, seal, type Session } from "@shahi/shared/e2e";
import { Auth } from "./auth";
import type { Config } from "./config";
import type { HerdrClient } from "./herdr-client";
import { createServer, type ShahiServer } from "./http";
import { serverIdFor, serverIdentity, type ServerIdentity } from "./identity";
import { Devices, Pairing } from "./pairing";
import { Poller } from "./poller";
import { PushService } from "./push";
import { RelayClient, boxUrl } from "./relay-client";
import { SessionStore } from "./state";
import { TranscriptStore } from "./transcript";

const PANE = "w1:p1";
const PASSCODE = "2468";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const hashOf = (bytes: Uint8Array) => b64(sha256(bytes));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/* ------------------------------------------------------------ fake relay */

interface BoxConn {
  ws: { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };
  phones: Map<number, { send(data: Uint8Array): void; close(code?: number, reason?: string): void }>;
  nextLink: number;
}

type RelayData =
  | { role: "box"; serverId: string; nonce: string; authed: boolean }
  | { role: "phone"; serverId: string; link: number };

interface FakeRelay {
  url: string;
  boxes: Map<string, BoxConn>;
  /** Auth frames seen, good or bad. */
  authAttempts: number;
  boxConnections: number;
  /** When set, a box gets no challenge — a relay that accepted the socket and went quiet. */
  silent: boolean;
  dropBox(serverId: string): void;
  stop(): void;
}

function fakeRelay(): FakeRelay {
  const state: FakeRelay = {
    url: "",
    boxes: new Map(),
    authAttempts: 0,
    boxConnections: 0,
    silent: false,
    dropBox: (serverId) => state.boxes.get(serverId)?.ws.close(1012, "relay restarting"),
    stop: () => server.stop(true),
  };

  const server = Bun.serve<RelayData, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const match = new URL(req.url).pathname.match(/^\/v1\/(box|phone)\/([^/]+)$/);
      if (!match) return new Response("not found", { status: 404 });
      const serverId = match[2]!;
      const data: RelayData =
        match[1] === "box"
          ? { role: "box", serverId, nonce: b64(crypto.getRandomValues(new Uint8Array(32))), authed: false }
          : { role: "phone", serverId, link: 0 };
      return srv.upgrade(req, { data }) ? undefined : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.role === "box") {
          state.boxConnections += 1;
          if (!state.silent) ws.send(JSON.stringify({ t: "challenge", nonce: ws.data.nonce }));
          return;
        }
        const box = state.boxes.get(ws.data.serverId);
        if (!box) {
          ws.close(RELAY_CLOSE.boxOffline, "box offline");
          return;
        }
        box.nextLink += 1;
        ws.data.link = box.nextLink;
        box.phones.set(ws.data.link, ws);
        box.ws.send(JSON.stringify({ t: "open", link: ws.data.link }));
      },
      message(ws, raw) {
        if (ws.data.role === "box") {
          if (typeof raw === "string") {
            const msg = JSON.parse(raw) as BoxToRelay;
            if (msg.t === "auth") {
              state.authAttempts += 1;
              const pub = unb64(msg.pub);
              const signed = encoder.encode(BOX_AUTH_PREFIX + ws.data.serverId + ws.data.nonce);
              let ok = false;
              try {
                ok = serverIdFor(pub) === ws.data.serverId && ed25519.verify(unb64(msg.sig), signed, pub);
              } catch {
                ok = false;
              }
              if (!ok) {
                ws.close(RELAY_CLOSE.unauthorized, "unauthorized");
                return;
              }
              state.boxes.get(ws.data.serverId)?.ws.close(RELAY_CLOSE.replaced, "replaced");
              ws.data.authed = true;
              state.boxes.set(ws.data.serverId, { ws, phones: new Map(), nextLink: 0 });
              ws.send(JSON.stringify({ t: "ready" }));
            } else if (msg.t === "close") {
              const box = state.boxes.get(ws.data.serverId);
              box?.phones.get(msg.link)?.close(1000, "closed by box");
              box?.phones.delete(msg.link);
            }
            return;
          }
          const bytes = new Uint8Array(raw);
          const link = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
          state.boxes.get(ws.data.serverId)?.phones.get(link)?.send(bytes.subarray(LINK_PREFIX_BYTES));
          return;
        }
        const box = state.boxes.get(ws.data.serverId);
        if (!box) return;
        const payload = typeof raw === "string" ? encoder.encode(raw) : new Uint8Array(raw);
        const frame = new Uint8Array(LINK_PREFIX_BYTES + payload.length);
        new DataView(frame.buffer).setUint32(0, ws.data.link, false);
        frame.set(payload, LINK_PREFIX_BYTES);
        box.ws.send(frame);
      },
      close(ws) {
        if (ws.data.role === "box") {
          const box = state.boxes.get(ws.data.serverId);
          if (box?.ws !== ws) return;
          for (const phone of box.phones.values()) phone.close(RELAY_CLOSE.boxOffline, "box offline");
          state.boxes.delete(ws.data.serverId);
          return;
        }
        const box = state.boxes.get(ws.data.serverId);
        if (box?.phones.get(ws.data.link)) {
          box.phones.delete(ws.data.link);
          box.ws.send(JSON.stringify({ t: "close", link: ws.data.link }));
        }
      },
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  return state;
}

/* ------------------------------------------------------------ fake phone */

interface Phone {
  /** Resolves once the box's hello has arrived and the session is derived. */
  hello: Promise<BoxHello>;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RelayResponse>;
  stream: SocketMessage[];
  watch(paneId: string): void;
  unwatch(): void;
  /** Sends the previous sealed frame again, byte for byte. */
  replayLast(): void;
  closed: Promise<{ code: number; reason: string }>;
  isClosed: boolean;
  close(): void;
}

function phone(relay: FakeRelay, serverId: string, auth: PhoneHello["auth"], secret: Uint8Array): Phone {
  const ws = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/phone/${serverId}`);
  ws.binaryType = "arraybuffer";
  const self = ephemeral(crypto.getRandomValues(new Uint8Array(32)));
  let session: Session | null = null;
  let nextId = 1;
  const pending = new Map<number, (res: RelayResponse) => void>();
  const stream: SocketMessage[] = [];

  let resolveHello!: (hello: BoxHello) => void;
  let rejectHello!: (err: Error) => void;
  const helloPromise = new Promise<BoxHello>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  let resolveClosed!: (end: { code: number; reason: string }) => void;
  const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });

  let lastFrame: Uint8Array | null = null;
  const sendSealed = (msg: PhoneToBox) => {
    if (!session) throw new Error("phone: no session yet");
    lastFrame = seal(session, encoder.encode(JSON.stringify(msg)));
    ws.send(lastFrame);
  };

  ws.onopen = () => {
    const hello: PhoneHello = { t: "hello", v: RELAY_PROTOCOL, pub: b64(self.pub), auth };
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = (event) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if (!session) {
      const hello = JSON.parse(decoder.decode(bytes)) as BoxHello;
      session = clientSession(self, unb64(hello.pub), secret);
      resolveHello(hello);
      return;
    }
    let plain: Uint8Array;
    try {
      plain = open(session, bytes);
    } catch {
      // A phone holding the wrong secret cannot read the box's pushes; it
      // learns nothing, and the box ends the link at its first frame.
      return;
    }
    const msg = JSON.parse(decoder.decode(plain)) as BoxToPhone;
    if (msg.t === "res") {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if (msg.t === "ws") {
      stream.push(msg.data as SocketMessage);
    }
  };
  const result: Phone = {
    hello: helloPromise,
    stream,
    isClosed: false,
    closed: closedPromise,
    request(method, path, body, headers = {}) {
      const id = nextId++;
      const req: RelayRequest = {
        t: "req",
        id,
        method,
        path,
        headers: { "x-shahi-api": String(SHAHI_API_VERSION), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body !== undefined ? b64(encoder.encode(JSON.stringify(body))) : null,
      };
      return new Promise((resolve) => {
        pending.set(id, resolve);
        sendSealed(req);
      });
    },
    watch: (paneId) => sendSealed({ t: "ws", data: { type: "watch", paneId } }),
    unwatch: () => sendSealed({ t: "ws", data: { type: "unwatch" } }),
    replayLast: () => {
      if (!lastFrame) throw new Error("phone: nothing sent yet");
      ws.send(lastFrame);
    },
    close: () => ws.close(1000, "done"),
  };
  ws.onclose = (event) => {
    result.isClosed = true;
    rejectHello(new Error(`closed before hello (${event.code})`));
    resolveClosed({ code: event.code, reason: event.reason });
  };
  return result;
}

/* ---------------------------------------------------------- the box side */

/** Enough of herdr for a dashboard and one watched pane. */
function fakeHerdr(): HerdrClient {
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
    rpc: async (method: string) => {
      switch (method) {
        case "session.snapshot":
          return { snapshot };
        case "pane.read":
          return { read: { text: "$ echo through the relay\nthrough the relay\n$ " } };
        case "pane.get":
          return { pane };
        default:
          throw new Error(`fake herdr has no ${method}`);
      }
    },
  } as unknown as HerdrClient;
}

interface Box {
  server: ShahiServer;
  identity: ServerIdentity;
  devices: Devices;
  pairing: Pairing;
  auth: Auth;
  cookie: string;
  log: string[];
  stop(): void;
}

const scratch = mkdtempSync(join(tmpdir(), "shahi-relay-"));
let passcodeHash = "";
let booted = 0;

async function bootBox(): Promise<Box> {
  const n = booted++;
  const dataPath = join(scratch, `box-${n}.sqlite`);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    socketPath: "",
    dataPath,
    passcodeHash,
    sessionSecret: "test-secret",
    sessionTtlMs: 60_000,
    vapid: null,
    webRoot: null,
    relayUrl: null,
  };
  const db = new Database(dataPath, { create: true });
  const devices = new Devices(db);
  const pairing = new Pairing();
  const auth = new Auth({
    passcodeHash,
    sessionSecret: config.sessionSecret,
    sessionTtlMs: config.sessionTtlMs,
    deviceActive: (id) => devices.isActive(id),
  });
  const client = fakeHerdr();
  const store = new SessionStore(client);
  await store.resync();
  const transcript = new TranscriptStore(join(scratch, `t-${n}.sqlite`));
  const poller = new Poller(client, store, transcript);
  poller.on("error", () => undefined);
  poller.start();
  const push = new PushService(db, config);
  const identity = serverIdentity(db);
  const server = createServer({
    config,
    auth,
    client,
    store,
    poller,
    transcript,
    push,
    pairing,
    devices,
    serverId: identity.serverId,
  });
  const login = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return {
    server,
    identity,
    devices,
    pairing,
    auth,
    cookie,
    log: [],
    stop: () => {
      poller.stop();
      server.stop(true);
    },
  };
}

function dial(relay: FakeRelay, box: Box, identity = box.identity): RelayClient {
  const client = new RelayClient(
    { url: relay.url, identity, devices: box.devices, pairing: box.pairing, auth: box.auth, server: box.server, log: (l) => box.log.push(l) },
    { minBackoffMs: 20, maxBackoffMs: 200, authTimeoutMs: 150 },
  );
  client.start();
  return client;
}

let relay: FakeRelay;
let box: Box;
let client: RelayClient;

beforeAll(async () => {
  passcodeHash = await Auth.hashPasscode(PASSCODE);
  relay = fakeRelay();
  box = await bootBox();
  client = dial(relay, box);
  await waitFor(() => client.connected, "the box to authenticate");
});

afterAll(() => {
  client.stop();
  box.stop();
  relay.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ tests */

describe("box authentication", () => {
  test("the box URL is the relay's over ws(s), with the server id on the path", () => {
    expect(boxUrl("https://relay.example.workers.dev", "abc")).toBe("wss://relay.example.workers.dev/v1/box/abc");
    expect(boxUrl("http://127.0.0.1:9999/", "abc")).toBe("ws://127.0.0.1:9999/v1/box/abc");
  });

  test("a box that signs the challenge is ready, under the id its key hashes to", () => {
    expect(relay.boxes.has(box.identity.serverId)).toBe(true);
    expect(box.log.some((l) => l.startsWith("relay: connected"))).toBe(true);
  });

  test("a box whose signature does not verify is closed with 4401 and keeps trying, never ready", async () => {
    const forged: ServerIdentity = { ...box.identity, sign: () => new Uint8Array(64) };
    const other = await bootBox();
    const before = relay.authAttempts;
    const impostor = dial(relay, other, forged);
    try {
      await waitFor(() => relay.authAttempts >= before + 3, "three refused auth attempts");
      expect(impostor.connected).toBe(false);
      expect(other.log.some((l) => l.includes(String(RELAY_CLOSE.unauthorized)))).toBe(true);
      // The real box was not displaced by the forgery.
      expect(client.connected).toBe(true);
    } finally {
      impostor.stop();
      other.stop();
    }
  });

  test("a relay that never answers is abandoned after the auth timeout and dialled again", async () => {
    const quiet = await bootBox();
    const other = fakeRelay();
    other.silent = true;
    const dialler = dial(other, quiet);
    try {
      await waitFor(() => other.boxConnections >= 2, "a redial after the auth timeout", 3_000);
      expect(dialler.connected).toBe(false);
      expect(quiet.log.some((l) => l.includes("no ready"))).toBe(true);
    } finally {
      dialler.stop();
      quiet.stop();
      other.stop();
    }
  });
});

describe("a phone through the relay", () => {
  let paired: ClaimResult;

  test("pairs over a pairing link — hello by hash, the claim answers the device secret, sealed", async () => {
    const code = box.pairing.mint();
    const secretBytes = unb64(code.secret);
    const p = phone(relay, box.identity.serverId, { kind: "pairing", id: hashOf(secretBytes) }, secretBytes);
    const hello = await p.hello;
    expect(hello).toMatchObject({ t: "hello", v: RELAY_PROTOCOL });
    expect(unb64(hello.pub)).toHaveLength(32);

    // Only the claim; a pairing link is not a session.
    const refused = await p.request("GET", "/api/session");
    expect(refused.status).toBe(403);

    const res = await p.request("POST", "/api/pair/claim", { secret: code.secret, deviceName: "Test iPhone" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.headers).every((h) => ["content-type", "etag", "cache-control"].includes(h))).toBe(true);
    paired = JSON.parse(decoder.decode(unb64(res.body!))) as ClaimResult;
    expect(paired.ok).toBe(true);
    expect(box.devices.list().map((d) => d.id)).toContain(paired.deviceId);
    expect(b64(box.devices.secret(paired.deviceId)!)).toBe(paired.deviceSecret);
    // No stream on a pairing link, and the code is spent.
    expect(p.stream).toHaveLength(0);
    expect(box.pairing.secretByHash(hashOf(secretBytes))).toBeNull();
    p.close();
    await p.closed;
  });

  test("then comes back as that device: the dashboard arrives, and requests are answered by id in any order", async () => {
    const p = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await p.hello;
    const [session, missing, meta] = await Promise.all([
      p.request("GET", "/api/session"),
      p.request("GET", "/api/panes/nope"),
      p.request("GET", "/api/meta"),
    ]);
    expect(session.status).toBe(200);
    expect(session.headers["content-type"]).toBe("application/json");
    const dashboard = JSON.parse(decoder.decode(unb64(session.body!))) as { panes: { paneId: string }[] };
    expect(dashboard.panes.map((x) => x.paneId)).toEqual([PANE]);
    expect(missing.status).toBe(404);
    expect(JSON.parse(decoder.decode(unb64(meta.body!)))).toMatchObject({ serverId: box.identity.serverId });

    // The first push on a device link is the dashboard, as on a `/ws` open.
    await waitFor(() => p.stream.some((m) => m.type === "session"), "the session push");

    // The contract gate runs on a link as on the port.
    const stale = await p.request("GET", "/api/session", undefined, { "x-shahi-api": "1" });
    expect(stale.status).toBe(426);
    p.close();
    await p.closed;
  });

  test("a link cannot choose its own session or rate-limit bucket by sending headers", async () => {
    const p = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await p.hello;
    // A cookie for a device that does not exist would be a 401 if honoured;
    // the link's own session wins.
    const res = await p.request("GET", "/api/devices", undefined, {
      cookie: "shahi_session=1.ghost.forged",
      origin: "https://evil.example",
      "x-forwarded-for": "203.0.113.5",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(decoder.decode(unb64(res.body!)))).toMatchObject({ thisDeviceId: paired.deviceId });
    p.close();
    await p.closed;
  });

  test("an unknown device and an unknown pairing code are closed at the hello", async () => {
    const ghost = phone(relay, box.identity.serverId, { kind: "device", deviceId: "no-such-device" }, new Uint8Array(32));
    await expect(ghost.hello).rejects.toThrow(/closed before hello/);
    const stranger = phone(relay, box.identity.serverId, { kind: "pairing", id: hashOf(new Uint8Array(32)) }, new Uint8Array(32));
    await expect(stranger.hello).rejects.toThrow(/closed before hello/);
    expect(box.log.some((l) => l.includes("unknown device"))).toBe(true);
    expect(box.log.some((l) => l.includes("unknown pairing code"))).toBe(true);
  });

  test("a phone that knows the device id but not its secret is closed at its first sealed frame", async () => {
    const wrong = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, new Uint8Array(32));
    await wrong.hello;
    const answer = wrong.request("GET", "/api/session");
    const end = await wrong.closed;
    expect(end.code).toBe(1000);
    // Nothing was answered, and nothing will be.
    expect(await Promise.race([answer, Bun.sleep(100).then(() => "nothing")])).toBe("nothing");
    expect(box.log.some((l) => l.includes("did not open"))).toBe(true);
  });

  test("a replayed frame ends the link", async () => {
    const p = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await p.hello;
    expect((await p.request("GET", "/api/meta")).status).toBe(200);
    p.replayLast();
    expect((await p.closed).code).toBe(1000);
    expect(box.log.some((l) => l.includes("did not open"))).toBe(true);
  });

  test("watch over the link produces the pane's frame push, and unwatch stops it", async () => {
    const p = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await p.hello;
    p.watch(PANE);
    await waitFor(() => p.stream.some((m) => m.type === "frame"), "a frame push");
    const frame = p.stream.find((m) => m.type === "frame")!;
    expect(frame).toMatchObject({ type: "frame", frame: { paneId: PANE } });
    expect((frame as { frame: { text: string } }).frame.text).toContain("through the relay");
    p.unwatch();
    p.close();
    await p.closed;
  });

  test("revoking the device closes its link and refuses its next hello", async () => {
    const p = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await p.hello;
    expect((await p.request("GET", "/api/session")).status).toBe(200);

    const revoke = await fetch(`http://127.0.0.1:${box.server.port}/api/devices/${encodeURIComponent(paired.deviceId)}`, {
      method: "DELETE",
      headers: { cookie: box.cookie },
    });
    expect(revoke.status).toBe(200);
    const end = await p.closed;
    expect(end.code).toBe(1000);
    expect(box.log.some((l) => l.includes("device revoked"))).toBe(true);

    const again = phone(relay, box.identity.serverId, { kind: "device", deviceId: paired.deviceId }, unb64(paired.deviceSecret));
    await expect(again.hello).rejects.toThrow(/closed before hello/);
  });

  test("when the relay drops the box it reconnects, and a phone can come back", async () => {
    const code = box.pairing.mint();
    const secretBytes = unb64(code.secret);
    const before = phone(relay, box.identity.serverId, { kind: "pairing", id: hashOf(secretBytes) }, secretBytes);
    await before.hello;

    relay.dropBox(box.identity.serverId);
    // The relay closes the phones of a box that went away, and the box lets
    // go of everything the link held.
    expect((await before.closed).code).toBe(RELAY_CLOSE.boxOffline);
    await waitFor(() => !client.connected, "the box to notice the drop");
    await waitFor(() => client.connected && relay.boxes.has(box.identity.serverId), "the box to redial");
    expect(box.log.some((l) => l.includes("disconnected") && l.includes("retrying"))).toBe(true);

    const after = phone(relay, box.identity.serverId, { kind: "pairing", id: hashOf(secretBytes) }, secretBytes);
    await after.hello;
    const res = await after.request("POST", "/api/pair/claim", { secret: code.secret, deviceName: "Again" });
    expect(res.status).toBe(200);
    after.close();
    await after.closed;
  });
});
