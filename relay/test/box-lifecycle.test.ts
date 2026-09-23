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
  /** A box through the real `auth` path, with whatever else its `auth` carries. */
  async function authenticated(extra: Record<string, unknown> = {}) {
    const ws = await connect();
    await relay.webSocketMessage(ws, JSON.stringify({ ...signAuth(identity, ws.state.nonce), ...extra }));
    expect(ws.state.ready).toBe(true);
    return ws;
  }
  /** Every slot filled by a phone that has sent its hello, all past their grace. */
  async function speakingPhones(past = Date.now() - EVICTION_GRACE_MS - 5_000) {
    const phones = [];
    for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox; i++) {
      const ws = await phone();
      await relay.webSocketMessage(ws, new Uint8Array([i]).buffer);
      ws.state.since = past + i;
      phones.push(ws);
    }
    return phones;
  }
  return { relay, identity, sockets, box, connect, phone, authenticated, speakingPhones, alarm: () => alarm };
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

test("a phone that has spoken keeps its slot on a box that reports no proofs, and the newcomer is refused", async () => {
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

test("hellos naming a real device without its secret cannot keep the owner's phone out", async () => {
  // The box answers such a hello and waits fifteen seconds for a sealed frame
  // that never comes, and a phone that had spoken kept its slot all that time.
  // Anyone holding a device id and no secret — a revoked phone that once read
  // the device list — could keep all eight slots and lock the owner's phones
  // out (review 2026-09-22, F33). Only the box can tell them apart.
  const f = fixture(), live = await f.authenticated({ proofs: true });
  const squatters = await f.speakingPhones();
  const owner = await f.phone();
  expect(owner.tags).toContain("phone");
  expect(squatters[0]!.closes).toEqual([4429]);
  expect(squatters[0]!.reason).toBe("too many phones");
  expect(squatters.slice(1).every((s) => s.closes.length === 0)).toBe(true);
  expect(live.sent.slice(-2).map((m) => JSON.parse(m as string))).toEqual([{ t: "close", link: 1 }, { t: "open", link: 9 }]);
});

test("a phone the box has proven keeps its slot, and the newcomer is refused", async () => {
  const f = fixture(), live = await f.authenticated({ proofs: true });
  const phones = await f.speakingPhones();
  for (const phone of phones) await f.relay.webSocketMessage(live, JSON.stringify({ t: "proven", link: phone.state.link }));
  expect(phones.every((p) => p.state.proven === true)).toBe(true);
  const newcomer = await f.phone();
  expect(newcomer.tags).toEqual(["refused"]);
  expect(newcomer.closes).toEqual([4429]);
  expect(phones.every((p) => p.closes.length === 0)).toBe(true);
});

test("the newcomer passes over proven phones to the one that has not proven itself", async () => {
  const f = fixture(), live = await f.authenticated({ proofs: true });
  const phones = await f.speakingPhones();
  // The oldest seven proved themselves; the youngest never did.
  for (const phone of phones.slice(0, -1)) await f.relay.webSocketMessage(live, JSON.stringify({ t: "proven", link: phone.state.link }));
  await f.phone();
  expect(phones.at(-1)!.closes).toEqual([4429]);
  expect(phones.slice(0, -1).every((p) => p.closes.length === 0)).toBe(true);
});

test("a silent squatter makes room before a phone that has spoken but not yet proven itself", async () => {
  const f = fixture(), past = Date.now() - EVICTION_GRACE_MS - 5_000;
  await f.authenticated({ proofs: true });
  const phones = [];
  for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox - 1; i++) {
    const phone = await f.phone();
    await f.relay.webSocketMessage(phone, new Uint8Array([i]).buffer);
    phone.state.since = past + i;
    phones.push(phone);
  }
  // Younger than every phone that has spoken, but past its grace, and silent.
  const silent = await f.phone();
  silent.state.since = past + 100;
  await f.phone();
  expect(silent.closes).toEqual([4429]);
  expect(phones.every((p) => p.closes.length === 0)).toBe(true);
});

test("a phone that has spoken but not proven itself is not evicted inside its grace", async () => {
  const f = fixture();
  await f.authenticated({ proofs: true });
  const phones = await f.speakingPhones(Date.now());
  const newcomer = await f.phone();
  expect(newcomer.tags).toEqual(["refused"]);
  expect(phones.every((p) => p.closes.length === 0)).toBe(true);
});

test("a box that predates proofs keeps the old rule: a phone that has spoken holds its slot", async () => {
  // A relay deployed with `proven` still serves boxes that never send it. For
  // those, closing a link that has spoken could close the owner's own phone,
  // so nothing changes: a newcomer is refused. A `proofs` that is not `true`
  // is no promise either.
  for (const extra of [{}, { proofs: 1 }, { proofs: "true" }]) {
    const f = fixture(), live = await f.authenticated(extra);
    expect(live.state.proofs).toBe(false);
    const phones = await f.speakingPhones();
    const newcomer = await f.phone();
    expect(newcomer.tags).toEqual(["refused"]);
    expect(phones.every((p) => p.closes.length === 0)).toBe(true);
  }
});

test("a malformed proven control changes nothing and never takes the relay down", async () => {
  const f = fixture(), live = await f.authenticated({ proofs: true });
  const phones = await f.speakingPhones();
  for (const control of [
    '{"t":"proven"}', '{"t":"proven","link":"1"}', '{"t":"proven","link":null}', '{"t":"proven","link":{}}',
    '{"t":"proven","link":[1]}', '{"t":"proven","link":-1}', '{"t":"proven","link":1.5}', '{"t":"proven","link":99}',
    '{"t":"proven","link":1e999}', '{"t":"PROVEN","link":1}', '["proven",1]', "null", "proven", '{"t":"proven","link":1',
  ]) await f.relay.webSocketMessage(live, control);
  expect(live.state.ready).toBe(true);
  expect(live.closes).toHaveLength(0);
  expect(phones.every((p) => !p.state.proven && p.closes.length === 0)).toBe(true);
  // Nothing was proven, so the oldest still makes room.
  await f.phone();
  expect(phones[0]!.closes).toEqual([4429]);
});

test("a box that has not authenticated cannot vouch for a link", async () => {
  const f = fixture(), live = await f.authenticated({ proofs: true });
  const phones = await f.speakingPhones();
  const stranger = await f.connect();
  await f.relay.webSocketMessage(stranger, JSON.stringify({ t: "proven", link: 1 }));
  expect(stranger.closes).toEqual([4401]);
  expect(phones[0]!.state.proven).toBeUndefined();
  expect(live.state.ready).toBe(true);
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
