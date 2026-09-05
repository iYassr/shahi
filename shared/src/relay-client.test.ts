import { afterEach, expect, test } from "bun:test";
import { RelayLink, fromBase64Url, pairingTarget, toBase64Url } from "./relay-client";
import { parsePairingUrl } from "./pairing";
import { RELAY_LIMITS, RELAY_PROTOCOL } from "./relay";
import { ephemeral, serverSession, open, seal, type Session } from "./e2e";

const secret = new Uint8Array(32).fill(8);
const server = toBase64Url(new Uint8Array(32).fill(9));
const code = `shahi://pair#v=1&server=${server}&relay=https%3A%2F%2Frelay.example&secret=${toBase64Url(secret)}`;
const originalSocket = globalThis.WebSocket;
const links: RelayLink[] = [];
class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(data: Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  receive(data: Uint8Array) { this.onmessage?.({ data: new Uint8Array(data).buffer }); }
}
function connect() {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const link = new RelayLink(pairingTarget("https://relay.example", server, toBase64Url(secret)));
  links.push(link);
  const response = link.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 1000);
  const socket = FakeSocket.last;
  socket.onopen!();
  return { link, socket, response };
}
function hello(socket: FakeSocket): Session {
  const client = JSON.parse(new TextDecoder().decode(socket.sent[0]));
  const box = ephemeral(new Uint8Array(32).fill(3));
  const session = serverSession(box, fromBase64Url(client.pub), secret);
  socket.receive(new TextEncoder().encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(box.pub) })));
  return session;
}
afterEach(() => {
  for (const link of links.splice(0)) link.close();
  globalThis.WebSocket = originalSocket;
});

test("hosted pairing keeps secrets in fragments and rejects ambiguous or credential-bearing codes", () => {
  expect(parsePairingUrl(`https://getshahi.dev/pwa/#pair=${encodeURIComponent(code)}`)).toEqual(parsePairingUrl(code));
  for (const bad of [
    code + "&secret=" + toBase64Url(secret),
    code.replace("relay.example", "name%3Apassword%40relay.example"),
    code.replace("relay.example", "relay.example%2F%3Fsecret%3Dx"),
    code.replace("relay.example", "relay.example%23secret"),
    code.replace("https%3A", "http%3A"),
    code.replace(server, "short"),
    code.replace(toBase64Url(secret), "invalid"),
    "https://getshahi.dev/pwa/?pair=" + encodeURIComponent(code),
  ]) expect(parsePairingUrl(bad)).toBeNull();
});

test("browser CSPRNG transport round-trips binary replies without exposing the pairing secret", async () => {
  const { socket, response } = connect();
  expect(new TextDecoder().decode(socket.sent[0])).not.toContain(toBase64Url(secret));
  expect(socket.url).not.toContain(toBase64Url(secret));
  const box = hello(socket);
  const request = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({
    t: "res", id: request.id, status: 200, headers: { "content-type": "application/octet-stream" },
    body: toBase64Url(new Uint8Array([0, 255, 128, 4])),
  }))));
  expect(Array.from(await (await response).bytes())).toEqual([0, 255, 128, 4]);
});

test("untrusted malformed or low-order hellos reject rather than escaping the socket callback", async () => {
  for (const pub of ["!", toBase64Url(new Uint8Array(32))]) {
    const { socket, response } = connect();
    expect(() => socket.receive(new TextEncoder().encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub })))).not.toThrow();
    await expect(response).rejects.toThrow("handshake");
  }
});

test("oversized relay frames are rejected before decoding", async () => {
  const { socket, response } = connect();
  socket.receive(new Uint8Array(RELAY_LIMITS.maxFrameBytes + 1));
  await expect(response).rejects.toThrow("oversized");
});

test("invalid encrypted response bodies reject their request without losing its promise", async () => {
  const { socket, response } = connect();
  const box = hello(socket);
  const request = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: request.id, status: 200, headers: {}, body: "!" }))));
  await expect(response).rejects.toThrow("invalid response");
});

test("a device proves its secret without waiting for a dashboard or an API request", () => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const link = new RelayLink({ relay: "https://relay.example", serverId: server, secret, auth: { kind: "device", deviceId: "test-device" } });
  links.push(link);
  link.ensureConnected();
  const socket = FakeSocket.last;
  socket.onopen!();
  const box = hello(socket);
  const proof = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  expect(proof).toEqual({ t: "ws", data: { type: "unwatch" } });
  expect(socket.sent).toHaveLength(2);
});
