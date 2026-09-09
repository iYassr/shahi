import { afterEach, beforeEach, expect, test } from "bun:test";
import { RelayClient } from "./relay-client";
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
beforeEach(() => {
  StuckSocket.opened = [];
  globalThis.WebSocket = StuckSocket as unknown as typeof WebSocket;
  client = new RelayClient({
    url: "https://relay.invalid", identity: fromSeed(new Uint8Array(32)),
    devices: { secret: () => null }, pairing: { secretByHash: () => null }, auth: { issue: () => "fixture" },
    server: { dispatch: async () => new Response(), attach: () => {}, detach: () => {}, receive: () => {} },
  }, { minBackoffMs: 1, maxBackoffMs: 5, authTimeoutMs: 40, silenceMs: 40, watchdogMs: 5, pingMs: 10 });
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
