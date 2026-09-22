/** Closing sockets can remain in getWebSockets and deliver late messages.
 * Model that documented runtime behavior without waiting for a TCP timeout. */
import { expect, mock, test } from "bun:test";
import { RELAY_LIMITS } from "@shahi/shared";
import { newBox, signAuth } from "./harness";
import { STRICT_TRANSPORT_SECURITY } from "../src/hsts";
import { EVICTION_GRACE_MS, MAX_PENDING_BOXES, PHONE_FRAME_MIN_BYTES } from "../src/limits";

mock.module("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: unknown) {} } }));
const { RelayBox } = await import(new URL("../src/box.ts", import.meta.url).href);

class Socket {
  readyState = 1;
  sent: unknown[] = [];
  closes: number[] = [];
  reason = "";
  constructor(public state: any, readonly tags: string[]) {}
  serializeAttachment(state: unknown) { this.state = structuredClone(state); }
  deserializeAttachment() { return structuredClone(this.state); }
  send(value: unknown) { this.sent.push(value); }
  close(code: number, reason = "") { this.readyState = 2; this.closes.push(code); this.reason = reason; }
}
function fixture() {
  const sockets: Socket[] = [];
  let alarm: number | null = null;
  const ctx = {
    getWebSockets: (tag?: string) => sockets.filter(s => !tag || s.tags.includes(tag)),
    acceptWebSocket: (s: Socket, tags: string[]) => { s.tags.push(...tags); sockets.push(s); },
    setWebSocketAutoResponse() {}, getWebSocketAutoResponseTimestamp: () => null,
    storage: { async setAlarm(n: number) { alarm = n; }, async deleteAlarm() { alarm = null; } },
  };
  const global = globalThis as any, original = global.WebSocketRequestResponsePair;
  global.WebSocketRequestResponsePair = class {};
  let relay: any;
  try { relay = new RelayBox(ctx, {}); } finally { global.WebSocketRequestResponsePair = original; }
  const identity = newBox();
  function box(ready = true, since = Date.now()) {
    const ws = new Socket({ role: "box", serverId: identity.serverId, nonce: "test-challenge", ready, since, heard: since, nextLink: 1 }, ["box"]);
    sockets.push(ws); return ws;
  }
  /** A box connection as the relay accepts it: challenged, not yet proven. */
  async function connect() { const ws = new Socket(null, []); await relay.acceptBox(ws, identity.serverId); return ws; }
  async function phone() { const ws = new Socket(null, []); await relay.acceptPhone(ws, identity.serverId); return ws; }
  return { relay, identity, sockets, box, connect, phone, alarm: () => alarm };
}

test("a closing phone cannot shadow a new phone after box replacement", async () => {
  const f = fixture(), oldBox = f.box(), oldPhone = await f.phone();
  await f.relay.webSocketClose(oldBox);
  expect(oldPhone.state.open).toBe(false);
  const replacement = f.box(), freshPhone = await f.phone();
  expect(freshPhone.state.link).toBe(oldPhone.state.link);
  await f.relay.webSocketMessage(replacement, new Uint8Array([0, 0, 0, 1, 42]).buffer);
  expect(freshPhone.sent).toHaveLength(1);
  expect([...new Uint8Array(freshPhone.sent[0] as ArrayBuffer)]).toEqual([42]);
  expect(oldPhone.sent).toHaveLength(0);
});

test("a closed box cannot authenticate again and evict the live box", async () => {
  const f = fixture(), oldBox = f.box();
  await f.relay.webSocketClose(oldBox);
  const current = f.box(), phone = await f.phone();
  await f.relay.webSocketMessage(oldBox, JSON.stringify(signAuth(f.identity, oldBox.state.nonce)));
  expect(current.state.ready).toBe(true);
  expect(current.closes).toHaveLength(0);
  expect(phone.state.open).toBe(true);
});

test("a late close from a departing phone cannot close its replacement link", async () => {
  const f = fixture(), oldBox = f.box(), oldPhone = await f.phone();
  oldPhone.readyState = 2;
  await f.relay.webSocketClose(oldBox);
  const current = f.box(); await f.phone();
  const before = current.sent.length;
  await f.relay.webSocketClose(oldPhone);
  expect(current.sent).toHaveLength(before);
});

test("authentication completing after the socket closes cannot revive it", async () => {
  const f = fixture(), pending = f.box(false);
  const authentication = f.relay.webSocketMessage(pending, JSON.stringify(signAuth(f.identity, pending.state.nonce)));
  await f.relay.webSocketClose(pending);
  await authentication;
  expect(pending.state.ready).toBe(false);
  expect(pending.sent).toHaveLength(0);
});

test("an expired pending box is excluded from future alarm scheduling", async () => {
  const f = fixture(), pending = f.box(false);
  pending.state.since = Date.now() - 60_000;
  await f.relay.alarm();
  expect(pending.closes).toHaveLength(1);
  expect(f.alarm()).toBeNull();
  await f.relay.alarm();
  expect(pending.closes).toHaveLength(1);
});

test("box authentication has a deadline even if the alarm has not fired", async () => {
  const f = fixture(), pending = f.box(false);
  pending.state.since = Date.now() - 60_000;
  await f.relay.webSocketMessage(pending, JSON.stringify(signAuth(f.identity, pending.state.nonce)));
  expect(pending.state.ready).toBe(false);
  expect(pending.closes).toContain(4401);
});

test("the real box reconnects while silent squatters hold every pending slot", async () => {
  const f = fixture(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  const squatters = Array.from({ length: MAX_PENDING_BOXES }, (_, i) => f.box(false, past + i));
  const real = await f.connect();
  expect(real.tags).toEqual(["box"]);
  expect(JSON.parse(real.sent[0] as string).t).toBe("challenge");
  // The longest-waiting squatter made room; the rest are untouched.
  expect(squatters[0]!.closes).toEqual([4429]);
  expect(squatters.slice(1).every((s) => s.closes.length === 0)).toBe(true);
  await f.relay.webSocketMessage(real, JSON.stringify(signAuth(f.identity, real.state.nonce)));
  expect(real.state.ready).toBe(true);
});

test("squatters reopened the moment one is evicted cannot evict the real box before it answers", async () => {
  const f = fixture(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  for (let i = 0; i < MAX_PENDING_BOXES; i++) f.box(false, past + i);
  const real = await f.connect();
  // An attacker watching its own sockets sees one evicted and answers with a burst.
  const burst = [];
  for (let i = 0; i < MAX_PENDING_BOXES; i++) burst.push(await f.connect());
  // Seven replace the remaining old squatters; the eighth finds only sockets
  // inside their grace, the real box among them, and is refused.
  expect(burst.slice(0, -1).every((s) => s.tags.includes("box"))).toBe(true);
  expect(burst.at(-1)!.tags).toEqual(["refused"]);
  expect(real.closes).toHaveLength(0);
  await f.relay.webSocketMessage(real, JSON.stringify(signAuth(f.identity, real.state.nonce)));
  expect(real.state.ready).toBe(true);
});

test("a pending box inside its grace is not evicted, and the newcomer is refused", async () => {
  const f = fixture();
  const pending = Array.from({ length: MAX_PENDING_BOXES }, () => f.box(false));
  const newcomer = await f.connect();
  expect(newcomer.tags).toEqual(["refused"]);
  expect(newcomer.closes).toEqual([4429]);
  expect(pending.every((s) => s.closes.length === 0)).toBe(true);
});

test("an authenticated box is never evicted to make room for a pending one", async () => {
  const f = fixture(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  const live = f.box(true, past - 60_000);
  for (let i = 0; i < MAX_PENDING_BOXES; i++) f.box(false, past + i);
  await f.connect();
  expect(live.closes).toHaveLength(0);
  expect(live.state.ready).toBe(true);
});

test("a real phone gets in while silent squatters hold every phone slot", async () => {
  const f = fixture(), live = f.box(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  const squatters = [];
  for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox; i++) {
    const squatter = await f.phone();
    squatter.state.since = past + i;
    squatters.push(squatter);
  }
  const real = await f.phone();
  expect(real.tags).toContain("phone");
  expect(squatters[0]!.closes).toEqual([4429]);
  expect(squatters.slice(1).every((s) => s.closes.length === 0)).toBe(true);
  // The box forgets the squatter's link before it learns the newcomer's.
  expect(live.sent.slice(-2).map((m) => JSON.parse(m as string))).toEqual([{ t: "close", link: 1 }, { t: "open", link: 9 }]);
});

test("a phone that has spoken keeps its slot, and the newcomer is refused", async () => {
  const f = fixture(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  f.box();
  const phones = [];
  for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox; i++) {
    const phone = await f.phone();
    phone.state.since = past;
    phone.state.spoke = true;
    phones.push(phone);
  }
  const newcomer = await f.phone();
  expect(newcomer.tags).toEqual(["refused"]);
  expect(phones.every((p) => p.closes.length === 0)).toBe(true);
});

test("a silent phone inside its grace is not evicted", async () => {
  const f = fixture();
  f.box();
  const phones = [];
  for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox; i++) phones.push(await f.phone());
  const newcomer = await f.phone();
  expect(newcomer.tags).toEqual(["refused"]);
  expect(phones.every((p) => p.closes.length === 0)).toBe(true);
});

test("an upgrade over HTTPS tells browsers to stay on HTTPS, and one over HTTP does not", async () => {
  // The relay sent no HSTS header at all (pre-release review 2026-09-22, P02-X1).
  const f = fixture();
  const global = globalThis as any, original = global.WebSocketPair;
  global.WebSocketPair = class { 0 = new Socket(null, []); 1 = new Socket(null, []); };
  try {
    const secure = await f.relay.fetch(new Request(`https://relay.example/v1/phone/${f.identity.serverId}`));
    expect(secure.status).toBe(101);
    expect(secure.headers.get("strict-transport-security")).toBe(STRICT_TRANSPORT_SECURITY);
    const plain = await f.relay.fetch(new Request(`http://127.0.0.1:8787/v1/box/${f.identity.serverId}`));
    expect(plain.status).toBe(101);
    expect(plain.headers.get("strict-transport-security")).toBeNull();
  } finally { global.WebSocketPair = original; }
});

test("a phone's text frames are charged against its rate, not free", async () => {
  // Text returned before the bucket was read, so a phone could send 4 KB text
  // frames as fast as TCP allowed and never be closed (review 2026-09-22, F79).
  const f = fixture(), box = f.box(), phone = await f.phone();
  const text = "x".repeat(RELAY_LIMITS.maxControlBytes);
  const burst = RELAY_LIMITS.phoneBurstBytes / text.length;
  for (let i = 0; i < burst * 2 && phone.readyState === 1; i++) await f.relay.webSocketMessage(phone, text);
  expect(phone.closes).toEqual([4429]);
  expect(phone.reason).toBe("rate");
  // Still dropped, never forwarded, and never taken for a hello.
  expect(box.sent.filter((m) => typeof m !== "string")).toHaveLength(0);
  expect(phone.state.spoke).toBe(false);
});

test("one-byte frames cannot outrun the rate by being tiny", async () => {
  // A 1-byte frame cost one token, so 64 KiB/s allowed about 65,000 frames a
  // second, each one waking the object (review 2026-09-22, F79).
  const f = fixture(), box = f.box(), phone = await f.phone();
  const frame = new Uint8Array([1]).buffer;
  const burst = RELAY_LIMITS.phoneBurstBytes / PHONE_FRAME_MIN_BYTES;
  for (let i = 0; i < burst * 2 && phone.readyState === 1; i++) await f.relay.webSocketMessage(phone, frame);
  expect(phone.closes).toEqual([4429]);
  expect(phone.reason).toBe("rate");
  // The burst is honoured, and then some refill while the loop ran, no more.
  const forwarded = box.sent.filter((m) => typeof m !== "string").length;
  expect(forwarded).toBeGreaterThanOrEqual(burst);
  expect(forwarded).toBeLessThan(burst * 1.25);
});

test("a phone's own small requests and acknowledgements are never taken for a flood", async () => {
  // The frame floor must not turn a real phone's small frames into a flood:
  // five requests a second and one acknowledgement per 64 KiB received, 32 a
  // second at a 2 MiB/s download, for ten minutes of simulated time.
  const f = fixture(), box = f.box(), phone = await f.phone();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const request = new Uint8Array(175).buffer, ack = new Uint8Array(50).buffer;
    for (let tick = 0; tick < 6_000 && phone.readyState === 1; tick++) {
      clock += 100;
      if (tick % 2 === 0) await f.relay.webSocketMessage(phone, request);
      for (let i = 0; i < 3; i++) await f.relay.webSocketMessage(phone, ack);
      if (tick % 5 === 0) await f.relay.webSocketMessage(phone, ack);
    }
  } finally { Date.now = realNow; }
  expect(phone.closes).toHaveLength(0);
  expect(box.sent.filter((m) => typeof m !== "string").length).toBeGreaterThan(20_000);
});
