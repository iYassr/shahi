/**
 * The relay transport, against a fake box on a fake socket.
 *
 * The box side here runs the real `e2e.ts` — `serverSession`, `seal`, `open`
 * — so the hello framing and the key derivation are checked on both ends of
 * the wire, not against a recording of what the phone sent. `WebSocket` is
 * faked the way `fetch` is in `api.test.ts`: a class that records what was
 * opened and sent, with methods a test uses to play the relay and the box.
 */
import { RELAY_CLOSE, RELAY_LIMITS, SHAHI_API_VERSION, RELAY_PROTOCOL, type BoxToPhone, type PhoneHello, type PhoneToBox, type RelayRequest } from "@shahi/shared";
import { sha256 } from "@noble/hashes/sha2.js";
import { ephemeral, open, seal, serverSession, type Session } from "../../../shared/src/e2e";
import { api, connection, IncompatibleServerError, SessionSocket, UnauthorizedError, UnreachableError } from "./api";
import {
  closeRelay,
  deviceTarget,
  fromBase64Url,
  pairingTarget,
  relayLink,
  toBase64Url,
  RelayLink,
  type RelayIdentity,
} from "./relay";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What React Native's WebSocket looks like from the transport's side. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  /** The phone hanging up: a close event follows, as it does on a device. */
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005 });
  }

  // --- the relay and the box, driven by a test ---
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(data: string) {
    this.onmessage?.({ data });
  }
  binary(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  /** The relay closing the phone's socket with one of its codes, and its reason. */
  drop(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** The box's half of `docs/relay.md`, keyed from whatever secret it holds. */
class FakeBox {
  session: Session | null = null;
  hello: PhoneHello | null = null;
  received: PhoneToBox[] = [];
  #readFrom = 0;

  constructor(
    readonly socket: FakeSocket,
    readonly secret: Uint8Array,
  ) {}

  /** Reads the phone's hello, answers with the box's, derives the session. */
  handshake(): PhoneHello {
    const first = this.socket.sent[this.#readFrom++];
    // In the clear but binary: the relay forwards data frames only.
    if (typeof first === "string") throw new Error("the hello must be a binary frame; the relay drops text from phones");
    this.hello = JSON.parse(str(first as Uint8Array)) as PhoneHello;
    const self = ephemeral(random(32));
    this.session = serverSession(self, fromBase64Url(this.hello.pub), this.secret);
    this.socket.binary(new TextEncoder().encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(self.pub) })));
    return this.hello;
  }

  /** Opens every sealed frame sent since the last read. Throws like the box would on a wrong key. */
  read(): PhoneToBox[] {
    const fresh: PhoneToBox[] = [];
    for (; this.#readFrom < this.socket.sent.length; this.#readFrom++) {
      const frame = this.socket.sent[this.#readFrom];
      if (!(frame instanceof Uint8Array)) throw new Error("frames after the hello must be binary");
      fresh.push(JSON.parse(str(open(this.session!, frame))) as PhoneToBox);
    }
    this.received.push(...fresh);
    return fresh;
  }

  push(msg: BoxToPhone) {
    this.socket.binary(seal(this.session!, utf8(JSON.stringify(msg))));
  }

  /** Answers a request the way the sidecar's HTTP layer would. */
  answer(req: RelayRequest, status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
    const bytes = body instanceof Uint8Array ? body : utf8(typeof body === "string" ? body : JSON.stringify(body));
    this.push({ t: "res", id: req.id, status, headers, body: toBase64Url(bytes) });
  }
}

const identity: RelayIdentity = {
  relay: "https://relay.example.dev",
  serverId: "Zm9v-bar_baz",
  deviceId: "dev-1",
  deviceSecret: toBase64Url(random(32)),
};
const secret = fromBase64Url(identity.deviceSecret);

/** Opens a link for a request, lets the relay accept it and the box greet it. */
async function openLink(box = secret): Promise<{ link: RelayLink; socket: FakeSocket; box: FakeBox }> {
  const target = deviceTarget(identity);
  connection.relay = target;
  const link = relayLink(target);
  link.ensureConnected();
  const socket = FakeSocket.opened.at(-1)!;
  socket.accept();
  const fake = new FakeBox(socket, box);
  fake.handshake();
  await tick();
  return { link, socket, box: fake };
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.opened = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  connection.baseUrl = "";
  connection.cookie = null;
});
afterEach(() => {
  closeRelay();
  connection.relay = null;
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("hello", () => {
  test("opens one socket at the relay's phone endpoint, greets as the device with a fresh key, and both ends derive the same session", async () => {
    const { link, socket, box } = await openLink();
    expect(socket.url).toBe("wss://relay.example.dev/v1/phone/Zm9v-bar_baz");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(box.hello).toMatchObject({ t: "hello", v: 1, auth: { kind: "device", deviceId: "dev-1" } });
    expect(fromBase64Url(box.hello!.pub)).toHaveLength(32);
    expect(link.state).toBe("live");

    // The proof of shared keys: a request sealed here opens there, and the
    // answer sealed there opens here.
    const reply = link.request({ method: "GET", path: "/api/session", headers: { "x-shahi-api": "9" }, body: null }, 1000);
    const [req] = box.read() as RelayRequest[];
    expect(req).toMatchObject({ t: "req", id: 1, method: "GET", path: "/api/session", headers: { "x-shahi-api": "9" }, body: null });
    box.answer(req!, 200, { panes: [] });
    const res = await reply;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({ panes: [] });
  });

  test("the path never travels in the clear", async () => {
    const { link, socket } = await openLink();
    void link.request({ method: "POST", path: "/api/panes/w1:p1/prompt", headers: {}, body: utf8('{"text":"rm -rf"}') }, 1000).catch(() => undefined);
    const frame = socket.sent.at(-1) as Uint8Array;
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(str(frame)).not.toContain("prompt");
    expect(str(frame)).not.toContain("rm -rf");
  });

  test("a link the relay refuses backs off, instead of knocking every half second", async () => {
    // A refused link opens and then closes with a code. Resetting the
    // backoff on open made a phone whose box was offline reconnect every
    // ~0.8s all day: measured at ~100k relay requests per phone-day.
    const target = deviceTarget(identity);
    connection.relay = target;
    relayLink(target).ensureConnected();
    const first = FakeSocket.opened.at(-1)!;
    first.accept();
    first.drop(RELAY_CLOSE.boxOffline, "box offline");
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(2);
    const second = FakeSocket.opened.at(-1)!;
    second.accept();
    second.drop(RELAY_CLOSE.boxOffline, "box offline");
    await sleep(600); // the backoff is 1s now: nothing yet
    expect(FakeSocket.opened).toHaveLength(2);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(3);
    // A box that answers is what resets it: the next drop retries in 500ms.
    const third = FakeSocket.opened.at(-1)!;
    third.accept();
    new FakeBox(third, secret).handshake();
    await tick();
    third.drop(1006);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(4);
  });

  test("a frame the relay would not carry is reported as too big, not as throttling", async () => {
    const { link, socket } = await openLink();
    const call = link.request({ method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(10) }, 1000);
    socket.drop(RELAY_CLOSE.quota, "frame too large");
    await expect(call).rejects.toThrow(/too big to send through the relay: one message carries up to 765 KB/);
  });

  test("every connection uses a different ephemeral key", async () => {
    const { socket, box } = await openLink();
    const first = box.hello!.pub;
    socket.drop(1006);
    await sleep(600); // past the first backoff step
    const again = FakeSocket.opened.at(-1)!;
    expect(again).not.toBe(socket);
    again.accept();
    const second = new FakeBox(again, secret).handshake();
    expect(second.pub).not.toBe(first);
  });

  test("a box speaking another protocol version is refused in words, and not retried", async () => {
    const target = deviceTarget(identity);
    const link = relayLink(target);
    const reply = link.request({ method: "GET", path: "/api/session", headers: {}, body: null }, 1000);
    const socket = FakeSocket.opened.at(-1)!;
    socket.accept();
    socket.binary(new TextEncoder().encode(JSON.stringify({ t: "hello", v: 2, pub: toBase64Url(new Uint8Array(32)) })));
    await expect(reply).rejects.toThrow(/protocol v2.*speaks v1/);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(1);
  });
});

describe("requests", () => {
  test("two in flight are matched by id, whichever answers first", async () => {
    const { link, box } = await openLink();
    const a = link.request({ method: "GET", path: "/api/a", headers: {}, body: null }, 1000);
    const b = link.request({ method: "GET", path: "/api/b", headers: {}, body: null }, 1000);
    const [ra, rb] = box.read() as RelayRequest[];
    expect([ra!.id, rb!.id]).toEqual([1, 2]);
    box.answer(rb!, 200, { which: "b" });
    box.answer(ra!, 200, { which: "a" });
    await expect((await a).json()).resolves.toEqual({ which: "a" });
    await expect((await b).json()).resolves.toEqual({ which: "b" });
  });

  test("one that is never answered times out in the caller's words, and a late answer is ignored", async () => {
    const { link, box } = await openLink();
    const reply = link.request({ method: "GET", path: "/api/slow", headers: {}, body: null }, 30);
    const [req] = box.read() as RelayRequest[];
    await expect(reply).rejects.toMatchObject({ reason: "timeout", message: expect.stringContaining("didn't answer within 0 seconds") });
    expect(() => box.answer(req!, 200, {})).not.toThrow();
  });

  // The caller retries; the transport never does. A prompt delivered twice is
  // worse than a prompt the person has to send again.
  test("one in flight when the link drops is rejected, and not resent after the reconnect", async () => {
    const { link, socket, box } = await openLink();
    const reply = link.request({ method: "POST", path: "/api/panes/x/prompt", headers: {}, body: utf8("{}") }, 5000);
    expect(box.read()).toHaveLength(1);
    socket.drop(1006);
    await expect(reply).rejects.toMatchObject({ reason: "lost" });

    await sleep(600);
    const again = FakeSocket.opened.at(-1)!;
    again.accept();
    const box2 = new FakeBox(again, secret);
    box2.handshake();
    await tick();
    expect(box2.read()).toEqual([]);
    expect(link.state).toBe("live");
  });

  test("one made while the link is down waits for it, then goes out exactly once", async () => {
    const target = deviceTarget(identity);
    connection.relay = target;
    const link = relayLink(target);
    const reply = link.request({ method: "GET", path: "/api/session", headers: {}, body: null }, 1000);
    const socket = FakeSocket.opened.at(-1)!;
    expect(socket.sent).toEqual([]); // nothing before the hello
    socket.accept();
    const box = new FakeBox(socket, secret);
    box.handshake();
    const [req] = box.read() as RelayRequest[];
    expect(req).toMatchObject({ path: "/api/session" });
    box.answer(req!, 200, {});
    await expect(reply).resolves.toMatchObject({ status: 200 });
  });

  test("a 426 over the relay is still an incompatible server, in the server's words", async () => {
    const { box } = await openLink();
    const call = api.session();
    await tick();
    const [req] = box.read() as RelayRequest[];
    // The contract version rides in the sealed headers, as it does on HTTP.
    expect(req!.headers["x-shahi-api"]).toBe(String(SHAHI_API_VERSION));
    box.answer(req!, 426, { error: "Update Shahi on this computer.", api: { min: 99, max: 99 } });
    await expect(call).rejects.toBeInstanceOf(IncompatibleServerError);
    await expect(call).rejects.toThrow("Update Shahi on this computer.");
  });

  test("a 401 over the relay signs out like one over HTTP", async () => {
    const { box } = await openLink();
    const call = api.session();
    await tick();
    box.answer(box.read()[0] as RelayRequest, 401, { error: "unauthorized" });
    await expect(call).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("the transcript poll over the relay", () => {
  // The reader polls this every 2.5s, and over the relay there is no HTTP
  // cache to revalidate for it — so it re-shipped the whole transcript every
  // poll until the phone sent the ETag itself. It rides in the sealed request
  // headers, and a 304 comes back with no body for the reader to parse.
  test("offers its ETag on the next poll, and a 304 needs no body", async () => {
    const { box } = await openLink();
    const first = api.sessionLog("relay:etag", 60);
    await tick();
    const [req1] = box.read() as RelayRequest[];
    expect(req1!.path).toBe("/api/panes/relay%3Aetag/session?limit=60");
    expect(req1!.headers["if-none-match"]).toBeUndefined();
    box.answer(req1!, 200, { paneId: "relay:etag", messages: [] }, { "content-type": "application/json", etag: 'W/"t1"' });
    await expect(first).resolves.toMatchObject({ paneId: "relay:etag" });

    const second = api.sessionLog("relay:etag", 60);
    await tick();
    const [req2] = box.read() as RelayRequest[];
    expect(req2!.headers["if-none-match"]).toBe('W/"t1"');
    box.answer(req2!, 304, null, { etag: 'W/"t1"' });
    // The same conversation is returned, from the kept body, not the wire.
    await expect(second).resolves.toMatchObject({ paneId: "relay:etag", messages: [] });
  });
});

describe("the relay's close codes", () => {
  test("4404 is the box being offline, said so, and retried", async () => {
    const target = deviceTarget(identity);
    connection.relay = target;
    const states: string[] = [];
    relayLink(target).subscribe({ onMessage: () => undefined, onLink: (s) => states.push(s) });
    const call = api.session();
    FakeSocket.opened.at(-1)!.drop(4404);
    const e = await call.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UnreachableError);
    expect((e as UnreachableError).reason).toBe("box");
    expect((e as Error).message).toBe("Your box is offline — its Shahi service is not connected to the relay.");
    expect(states).toEqual(["lost", "connecting", "lost"]);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(2); // the box may come back
  });

  test("4429 is the relay throttling this phone", async () => {
    connection.relay = deviceTarget(identity);
    const call = api.session();
    FakeSocket.opened.at(-1)!.drop(4429);
    await expect(call).rejects.toMatchObject({ reason: "relay", message: expect.stringContaining("throttling this phone") });
  });

  // A close code is relay-visible and unauthenticated. It can be a stale-link
  // race while a box restarts, so it must never erase a durable pairing.
  test("4403 retains a device pairing and reconnects", async () => {
    connection.relay = deviceTarget(identity);
    const expired = jest.fn();
    const socket = new SessionSocket(jest.fn(), jest.fn(), expired);
    socket.connect();
    const call = api.session();
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, random(32)); // a different secret
    box.handshake();
    expect(() => box.read()).toThrow(); // exactly what the real box hits
    ws.drop(4403);
    const e = await call.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UnreachableError);
    expect(expired).not.toHaveBeenCalled();
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  test("4401 also retains a device pairing; only a sealed bye may sign out", async () => {
    connection.relay = deviceTarget(identity);
    const expired = jest.fn();
    const socket = new SessionSocket(jest.fn(), jest.fn(), expired);
    socket.connect();
    FakeSocket.opened.at(-1)!.drop(4401);
    expect(expired).not.toHaveBeenCalled();
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  // Revocation cannot travel as a close code: the relay flattens a box-driven
  // close to 1000, which the phone would retry — reconnecting into a refused
  // hello forever, cut off but never signed out. The box sends a sealed `bye`
  // instead, and it is the mirror of a `/ws` 4001: sign out, and do not retry.
  test("a sealed bye from the box signs out and stops retrying", async () => {
    connection.relay = deviceTarget(identity);
    const expired = jest.fn();
    const socket = new SessionSocket(jest.fn(), jest.fn(), expired);
    socket.connect();
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, secret);
    box.handshake();
    box.push({ t: "bye" });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(3);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(1); // nothing reconnected
  });

  test("a late frame from another encrypted session drops only this connection", async () => {
    connection.relay = deviceTarget(identity);
    const expired = jest.fn();
    const socket = new SessionSocket(jest.fn(), jest.fn(), expired);
    socket.connect();
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, random(32));
    box.handshake();
    box.push({ t: "ws", data: { type: "ping", at: 1 } });
    expect(expired).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(3);
    await sleep(600);
    expect(FakeSocket.opened).toHaveLength(2);
  });
});

describe("the dashboard stream", () => {
  test("watch and unwatch travel as sealed frames, and the watch is repeated after a reconnect", async () => {
    connection.relay = deviceTarget(identity);
    const socket = new SessionSocket(jest.fn(), jest.fn());
    socket.connect();
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, secret);
    box.handshake();
    socket.watch("w1:p1");
    socket.watch(null);
    expect(box.read()).toEqual([
      { t: "ws", data: { type: "watch", paneId: "w1:p1" } },
      { t: "ws", data: { type: "unwatch" } },
    ]);

    socket.watch("w1:p2");
    box.read();
    ws.drop(1006);
    await sleep(600);
    const again = FakeSocket.opened.at(-1)!;
    again.accept();
    const box2 = new FakeBox(again, secret);
    box2.handshake();
    expect(box2.read()).toEqual([{ t: "ws", data: { type: "watch", paneId: "w1:p2" } }]);
  });

  test("a watch racing a native socket close does not throw", () => {
    const socket = new RelayLink(deviceTarget(identity));
    socket.ensureConnected();
    const wire = FakeSocket.opened[0]!;
    const box = new FakeBox(wire, secret);
    wire.accept();
    box.handshake();

    // Native can expose CLOSED before delivering onclose, leaving the old
    // crypto session in place for this event-loop turn.
    wire.readyState = 3;
    expect(() => socket.watch("w1:p1")).not.toThrow();
    expect(box.read()).toEqual([]);
  });

  test("the box's stream reaches onMessage; the heartbeat only keeps the link alive", async () => {
    connection.relay = deviceTarget(identity);
    const onMessage = jest.fn();
    const onLink = jest.fn();
    const socket = new SessionSocket(onMessage, onLink);
    socket.connect();
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, secret);
    box.handshake();
    expect(onLink).toHaveBeenLastCalledWith("live");
    box.push({ t: "ws", data: { type: "ping", at: 1 } });
    box.push({ t: "ws", data: { type: "log_changed", paneId: "w1:p1", offset: 10 } });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "log_changed", paneId: "w1:p1", offset: 10 });
    socket.close();
    box.push({ t: "ws", data: { type: "log_changed", paneId: "w1:p1", offset: 11 } });
    expect(onMessage).toHaveBeenCalledTimes(1); // unsubscribed
  });

  test("the socket and the requests share one link", async () => {
    connection.relay = deviceTarget(identity);
    const socket = new SessionSocket(jest.fn(), jest.fn());
    socket.connect();
    const call = api.session();
    expect(FakeSocket.opened).toHaveLength(1);
    const ws = FakeSocket.opened[0]!;
    ws.accept();
    const box = new FakeBox(ws, secret);
    box.handshake();
    box.answer(box.read()[0] as RelayRequest, 200, { panes: [] });
    await expect(call).resolves.toEqual({ panes: [] });
  });
});

describe("files over the relay", () => {
  test("an image comes back as a data URL, since there is no URL an Image could fetch", async () => {
    const { box } = await openLink();
    const call = api.readFile("/home/y/shot.png");
    await tick();
    const [req] = box.read() as RelayRequest[];
    expect(req!.path).toBe("/api/file?path=%2Fhome%2Fy%2Fshot.png");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    box.answer(req!, 200, png, { "content-type": "image/png" });
    // Standard base64 in the URL, not base64url: `Image` reads the data URL.
    await expect(call).resolves.toEqual({ imageUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` });
  });

  test("text comes back as text", async () => {
    const { box } = await openLink();
    const call = api.readFile("/home/y/x.ts");
    await tick();
    box.answer(box.read()[0] as RelayRequest, 200, "const x = 1; // ünïcödé", { "content-type": "text/plain; charset=utf-8" });
    await expect(call).resolves.toEqual({ text: "const x = 1; // ünïcödé" });
  });

  test("an upload the relay cannot carry is refused before a byte is sent, with the size", async () => {
    const { box } = await openLink();
    const bytes = new Uint8Array(RELAY_LIMITS.maxBodyBytes + 1);
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ arrayBuffer: async () => bytes.buffer }));
    try {
      await expect(api.upload({ uri: "file:///tmp/big.heic", name: "big.heic", type: "image/heic" })).rejects.toThrow(
        /This file is 765 KB and the relay carries up to 765 KB/,
      );
      expect(box.read()).toEqual([]);
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });

  test("an upload is the multipart body FormData would have built, with the file's bytes", async () => {
    const { box } = await openLink();
    const bytes = new Uint8Array([1, 2, 3, 0, 255, 13, 10]);
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ arrayBuffer: async () => bytes.buffer }));
    try {
      const call = api.upload({ uri: "file:///tmp/shot.png", name: "shot.png", type: "image/png" });
      await sleep(5);
      const [req] = box.read() as RelayRequest[];
      expect(req).toMatchObject({ method: "POST", path: "/api/uploads" });
      const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(req!.headers["content-type"]!)?.[1];
      expect(boundary).toBeTruthy();
      const body = fromBase64Url(req!.body!);
      const text = str(body);
      expect(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`)).toBe(true);
      expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
      const start = text.indexOf("\r\n\r\n") + 4;
      expect(Array.from(body.slice(start, start + bytes.length))).toEqual(Array.from(bytes));
      box.answer(req!, 200, { path: "/home/y/.shahi/uploads/shot.png", name: "shot.png", size: 7 });
      await expect(call).resolves.toMatchObject({ path: "/home/y/.shahi/uploads/shot.png" });
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });
});

describe("pairing over the relay", () => {
  test("the hello names the code by the hash of its bytes, and the claim answers with a device", async () => {
    const code = toBase64Url(random(32));
    const target = pairingTarget("https://relay.example.dev/", identity.serverId, code);
    connection.relay = target;
    const meta = api.meta();
    const ws = FakeSocket.opened.at(-1)!;
    expect(ws.url).toBe("wss://relay.example.dev/v1/phone/Zm9v-bar_baz");
    ws.accept();
    const box = new FakeBox(ws, fromBase64Url(code));
    const hello = box.handshake();
    expect(hello.auth).toEqual({ kind: "pairing", id: toBase64Url(sha256(fromBase64Url(code))) });
    expect(JSON.stringify(hello)).not.toContain(code);
    await tick();
    box.answer(box.read()[0] as RelayRequest, 200, {
      serverId: identity.serverId,
      serverVersion: "0.1.0",
      api: { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION },
      herdr: { version: "0.8.2", protocol: 20 },
    });
    await expect(meta).resolves.toMatchObject({ serverId: identity.serverId });

    const claim = api.claimRelayPairing(code, "Yasser's iPhone");
    await tick();
    const [req] = box.read() as RelayRequest[];
    expect(req).toMatchObject({ method: "POST", path: "/api/pair/claim", headers: { "content-type": "application/json" } });
    expect(JSON.parse(str(fromBase64Url(req!.body!)))).toEqual({ secret: code, deviceName: "Yasser's iPhone" });
    box.answer(req!, 200, { ok: true, deviceId: "dev-9", deviceSecret: identity.deviceSecret });
    await expect(claim).resolves.toEqual({ ok: true, deviceId: "dev-9", deviceSecret: identity.deviceSecret });
  });

  test("a spent code is refused in the box's words, not as a sign-out", async () => {
    const code = toBase64Url(random(32));
    connection.relay = pairingTarget("https://relay.example.dev", identity.serverId, code);
    const claim = api.claimRelayPairing(code, "iPhone");
    const ws = FakeSocket.opened.at(-1)!;
    ws.accept();
    const box = new FakeBox(ws, fromBase64Url(code));
    box.handshake();
    await tick();
    box.answer(box.read()[0] as RelayRequest, 401, { error: "That pairing code is not valid. A code works once and for ten minutes — print a new one." });
    await expect(claim).rejects.toThrow(/works once/);
  });

  test("a code whose secret is not 32 bytes is refused before anything is opened", () => {
    expect(() => pairingTarget("https://relay.example.dev", "s", "short")).toThrow(/not one a Shahi server prints/);
    expect(() => pairingTarget("https://relay.example.dev", "s", "not base64url!!")).toThrow(/not one a Shahi server prints/);
    expect(FakeSocket.opened).toHaveLength(0);
  });

  test("pointing the connection at a new target retires the pairing link", async () => {
    const code = toBase64Url(random(32));
    const pairing = pairingTarget("https://relay.example.dev", identity.serverId, code);
    const first = relayLink(pairing);
    first.ensureConnected();
    const ws = FakeSocket.opened.at(-1)!;
    const device = relayLink(deviceTarget(identity));
    expect(device).not.toBe(first);
    expect(ws.readyState).toBe(3);
    expect(relayLink(deviceTarget(identity))).not.toBe(device); // a new object is a new target
  });
});

describe("base64url", () => {
  test("round-trips every byte value and every length remainder", () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 1000]) {
      const bytes = random(n);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
    }
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  test("agrees with the platform's base64, and reads the padded standard form too", () => {
    const bytes = random(77);
    const standard = btoa(String.fromCharCode(...bytes));
    expect(toBase64Url(bytes)).toBe(standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    expect(Array.from(fromBase64Url(standard))).toEqual(Array.from(bytes));
  });
});
