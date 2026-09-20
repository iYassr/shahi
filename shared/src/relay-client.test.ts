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
  static count = 0;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) { FakeSocket.last = this; FakeSocket.count++; }
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

test("polling cannot bypass scheduled reconnect backoff", async () => {
  const { link, socket, response } = connect();
  const rejected = response.catch(() => {});
  socket.close();
  const before = FakeSocket.count;
  for (let i = 0; i < 1000; i++) link.ensureConnected();
  expect(FakeSocket.count).toBe(before);
  await rejected;
});

test("pending requests and body bytes have separate hard limits", async () => {
  const { link, response } = connect();
  void response.catch(() => {});
  const request = { method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(RELAY_LIMITS.maxBodyBytes) };
  void link.request(request, 5000).catch(() => {});
  void link.request(request, 5000).catch(() => {});
  await expect(link.request(request, 5000)).rejects.toThrow("Too many requests");
  for (let i = 3; i < RELAY_LIMITS.maxPendingRequests; i++) void link.request({ ...request, body: null }, 5000).catch(() => {});
  await expect(link.request({ ...request, body: null }, 5000)).rejects.toThrow("Too many requests");
});

test("delivery acknowledgments are encrypted and count actual received frame bytes", async () => {
  const { socket, response } = connect();
  const box = hello(socket);
  const request = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  const frame = seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: request.id, status: 200, headers: {}, body: toBase64Url(new Uint8Array(65536)) })));
  socket.receive(frame);
  expect((await (await response).bytes()).length).toBe(65536);
  expect(JSON.parse(new TextDecoder().decode(open(box, socket.sent[2]!)))).toEqual({ t: "ack", bytes: frame.length });
});

test("consecutive large uploads wait for relay capacity without dropping or replaying writes", async () => {
  const { link, socket, response } = connect();
  const box = hello(socket);
  const initial = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: initial.id, status: 200, headers: {}, body: null }))));
  await response;
  const before = socket.sent.length;
  const first = link.request({ method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(700 * 1024) }, 5000);
  const second = link.request({ method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(128 * 1024) }, 5000);
  const expired = link.request({ method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(128 * 1024) }, 20);
  const rejection = expect(expired).rejects.toThrow("didn't answer");
  expect(socket.sent.length).toBe(before + 1);
  const answer = (frame: Uint8Array) => {
    const req = JSON.parse(new TextDecoder().decode(open(box, frame)));
    socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: req.id, status: 200, headers: {}, body: null }))));
    return req;
  };
  answer(socket.sent[before]!);
  await first;
  await rejection;
  const deadline = Date.now() + 3500;
  while (socket.sent.length === before + 1 && Date.now() < deadline) await Bun.sleep(25);
  expect(socket.sent.length).toBe(before + 2);
  expect(answer(socket.sent[before + 1]!).path).toBe("/api/uploads");
  await second;
  await Bun.sleep(50);
  expect(socket.sent.length).toBe(before + 2); // Timed-out queued write was never sent.
  expect(socket.readyState).toBe(1);
}, 6000);

async function readyLink() {
  const connected = connect();
  const box = hello(connected.socket);
  const initial = JSON.parse(new TextDecoder().decode(open(box, connected.socket.sent[1]!)));
  connected.socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: initial.id, status: 200, headers: {}, body: null }))));
  await connected.response;
  return { ...connected, box };
}
const uploadRequest = (size: number) => ({ method: "POST", path: "/api/uploads", headers: {}, body: new Uint8Array(size) });

test("reconnection rejects both sent and capacity-queued uploads without replay", async () => {
  const { link, socket } = await readyLink();
  const before = socket.sent.length;
  const sent = link.request(uploadRequest(700 * 1024), 5000).catch(error => error);
  const queued = link.request(uploadRequest(128 * 1024), 5000).catch(error => error);
  expect(socket.sent.length).toBe(before + 1);
  link.reconnect();
  expect(await sent).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  await Bun.sleep(50);
  const replacement = FakeSocket.last;
  expect(replacement).not.toBe(socket);
  replacement.onopen!();
  hello(replacement);
  // A fresh handshake cannot replay either the uncertain sent write or the unsent queue.
  expect(replacement.sent).toHaveLength(1);
  await Bun.sleep(200);
  expect(replacement.sent).toHaveLength(1);
});

test("authenticated revocation cancels paced uploads and leaves no reconnect timer", async () => {
  const { link, socket, box } = await readyLink();
  let expired = 0;
  link.subscribe({ onLink() {}, onMessage() {}, onExpired() { expired++; } });
  const sent = link.request(uploadRequest(700 * 1024), 5000).catch(error => error);
  const queued = link.request(uploadRequest(128 * 1024), 5000).catch(error => error);
  const count = FakeSocket.count;
  socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "bye" }))));
  expect((await sent).name).toBe("UnauthorizedError");
  expect((await queued).name).toBe("UnauthorizedError");
  expect(expired).toBe(1);
  link.reconnect(); // Foreground recovery cannot revive a revoked device.
  await Bun.sleep(600);
  expect(FakeSocket.count).toBe(count);
  expect(socket.readyState).toBe(3);
});

test("an upload that expires before handshake is never sent once the server answers", async () => {
  const { link, socket, response } = connect();
  const expired = link.request(uploadRequest(128 * 1024), 10).catch(error => error);
  expect(await expired).toBeInstanceOf(Error);
  const box = hello(socket);
  expect(socket.sent).toHaveLength(2);
  const request = JSON.parse(new TextDecoder().decode(open(box, socket.sent[1]!)));
  expect(request.path).toBe("/api/meta");
  socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id: request.id, status: 200, headers: {}, body: null }))));
  await response;
});

test("a timed-out sent upload is not replayed and its late reply cannot settle a newer request", async () => {
  const { link, socket, box } = await readyLink();
  const index = socket.sent.length;
  const expired = link.request(uploadRequest(1024), 10).catch(error => error);
  const old = JSON.parse(new TextDecoder().decode(open(box, socket.sent[index]!)));
  expect(await expired).toBeInstanceOf(Error);
  let settled = false;
  const current = link.request({ method: "GET", path: "/api/meta", headers: {}, body: null }, 1000).then(reply => { settled = true; return reply; });
  const fresh = JSON.parse(new TextDecoder().decode(open(box, socket.sent[index + 1]!)));
  const answer = (id: number) => socket.receive(seal(box, new TextEncoder().encode(JSON.stringify({ t: "res", id, status: 200, headers: {}, body: null }))));
  answer(old.id);
  await Bun.sleep(10);
  expect(settled).toBe(false);
  expect(fresh.id).not.toBe(old.id);
  answer(fresh.id);
  await current;
  expect(socket.sent).toHaveLength(index + 2);
});


test("a spent pairing code closed by the box asks for a fresh code without retrying", async () => {
  const { link, socket, response } = connect();
  socket.onclose?.({ code: 1000, reason: "closed by box" } as never);
  await expect(response).rejects.toMatchObject({ name: "UnauthorizedError", message: expect.stringContaining("Show a new code") });
  expect(link.state).toBe("lost");
  const count = FakeSocket.count;
  await Bun.sleep(600);
  expect(FakeSocket.count).toBe(count);
});
