/** Closing sockets can remain in getWebSockets and deliver late messages.
 * Model that documented runtime behavior without waiting for a TCP timeout. */
import { expect, mock, test } from "bun:test";
import { newBox, signAuth } from "./harness";
import { EVICTION_GRACE_MS, MAX_PENDING_BOXES } from "../src/limits";

mock.module("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: unknown) {} } }));
const { RelayBox } = await import(new URL("../src/box.ts", import.meta.url).href);

class Socket {
  readyState = 1;
  sent: unknown[] = [];
  closes: number[] = [];
  constructor(public state: any, readonly tags: string[]) {}
  serializeAttachment(state: unknown) { this.state = structuredClone(state); }
  deserializeAttachment() { return structuredClone(this.state); }
  send(value: unknown) { this.sent.push(value); }
  close(code: number) { this.readyState = 2; this.closes.push(code); }
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
