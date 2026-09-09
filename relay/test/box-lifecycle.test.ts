/** Closing sockets can remain in getWebSockets and deliver late messages.
 * Model that documented runtime behavior without waiting for a TCP timeout. */
import { expect, mock, test } from "bun:test";
import { newBox, signAuth } from "./harness";

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
  function box(ready = true) {
    const ws = new Socket({ role: "box", serverId: identity.serverId, nonce: "test-challenge", ready, since: Date.now(), heard: Date.now(), nextLink: 1 }, ["box"]);
    sockets.push(ws); return ws;
  }
  async function phone() { const ws = new Socket(null, []); await relay.acceptPhone(ws, identity.serverId); return ws; }
  return { relay, identity, sockets, box, phone, alarm: () => alarm };
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
