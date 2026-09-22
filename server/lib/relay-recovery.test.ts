import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { RelayClient, type RelayClientOptions } from "./relay-client";
import { fromSeed } from "./identity";

/** Model sockets whose native close callback never arrives. No network or herdr. */
class StuckSocket {
  static OPEN = 1;
  static opened: StuckSocket[] = [];
  readyState = 0; binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { StuckSocket.opened.push(this); }
  send(_data: unknown) {}
  close() { this.readyState = 2; }
  authenticate() {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify({ t: "challenge", nonce: "a".repeat(43) }) });
    this.onmessage?.({ data: '{"t":"ready"}' });
  }
}
const nativeSocket = globalThis.WebSocket;
let client: RelayClient;
function makeClient(options: RelayClientOptions = {}) {
  return new RelayClient({
    url: "https://relay.invalid", identity: fromSeed(new Uint8Array(32)),
    devices: { secret: () => null, revokedSecret: () => null }, pairing: { secretByHash: () => null }, auth: { issue: () => "fixture" },
    server: { dispatch: async () => new Response(), attach: () => {}, detach: () => {}, receive: () => {} },
  }, { minBackoffMs: 1, maxBackoffMs: 5, authTimeoutMs: 40, silenceMs: 40, watchdogMs: 5, pingMs: 10, ...options });
}
beforeEach(() => {
  StuckSocket.opened = [];
  globalThis.WebSocket = StuckSocket as unknown as typeof WebSocket;
  client = makeClient();
});
afterEach(() => { client.stop(); globalThis.WebSocket = nativeSocket; });
async function redial() {
  const until = Date.now() + 2000;
  while (StuckSocket.opened.length < 2 && Date.now() < until) await Bun.sleep(5);
  expect(StuckSocket.opened.length).toBeGreaterThan(1);
}
test("the computer retries a stuck handshake without waiting for close", async () => {
  client.start(); await redial(); expect(client.connected).toBe(false);
});
test("the computer detaches a silent connection and ignores its late close", async () => {
  client.start(); const first = StuckSocket.opened[0]!;
  first.authenticate(); const lateClose = first.onclose!;
  await redial(); const next = StuckSocket.opened.at(-1)!; next.authenticate();
  lateClose({ code: 1006 }); expect(client.connected).toBe(true);
});
test("a ping send failure recovers without crashing the computer service", async () => {
  client.start(); const first = StuckSocket.opened[0]!;
  first.authenticate();
  first.send = () => { throw new Error("native send failed"); };
  await redial(); expect(client.connected).toBe(false);
});


test("wake replaces the socket even when a buffered pong arrives first", async () => {
  client.start(); const first = StuckSocket.opened[0]!; first.authenticate();
  const originalNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => originalNow() + 60_000);
  try {
    first.onmessage?.({ data: "pong" });
    await redial();
    expect(first.readyState).toBe(2);
    StuckSocket.opened.at(-1)!.authenticate();
    expect(client.connected).toBe(true);
  } finally { clock.mockRestore(); }
});

test("repeated outages recover and stop cancels further attempts", async () => {
  client.start();
  for (let i = 0; i < 5; i++) {
    const socket = StuckSocket.opened.at(-1)!; socket.authenticate();
    expect(client.connected).toBe(true);
    const count = StuckSocket.opened.length;
    socket.onerror?.();
    const until = Date.now() + 1000;
    while (StuckSocket.opened.length === count && Date.now() < until) await Bun.sleep(5);
    expect(StuckSocket.opened.length).toBe(count + 1);
  }
  client.stop(); const count = StuckSocket.opened.length;
  await Bun.sleep(100);
  expect(StuckSocket.opened.length).toBe(count);
  expect(client.connected).toBe(false);
});


test("wake interrupts a long retry wait, including before authentication", async () => {
  client.stop(); client = makeClient({ minBackoffMs: 30_000, maxBackoffMs: 30_000 });
  client.start(); StuckSocket.opened[0]!.onerror?.();
  const originalNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => originalNow() + 60_000);
  try { await redial(); StuckSocket.opened.at(-1)!.authenticate(); expect(client.connected).toBe(true); }
  finally { clock.mockRestore(); }
});

test("healthy pongs retain one connection and start is idempotent", async () => {
  client.start(); client.start();
  const socket = StuckSocket.opened[0]!; socket.authenticate();
  socket.send = () => { socket.onmessage?.({ data: "pong" }); };
  await Bun.sleep(120);
  expect(StuckSocket.opened.length).toBe(1);
  expect(client.connected).toBe(true);
});
