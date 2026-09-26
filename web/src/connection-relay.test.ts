import { afterEach, beforeEach, expect, test } from "bun:test";
import { RELAY_PROTOCOL } from "@shahi/shared";
import { ephemeral, open, seal, serverSession, type Session } from "@shahi/shared/e2e";
import { fromBase64Url, toBase64Url } from "@shahi/shared/relay-client";
import { browserComputers, browserConnection, forgetBrowser, pairBrowser, resumeComputers } from "./connection";
import { draftOwner, webDraft } from "./drafts";
import { SessionSocket, createApi } from "./api";

/*
 * The hosted PWA's relay links, end to end against a fake computer that
 * speaks the real sealed protocol. Nothing here reaches a network.
 */
const utf8 = { encode: (s: string) => new TextEncoder().encode(s), decode: (b: Uint8Array) => new TextDecoder().decode(b) };
const pairingSecret = new Uint8Array(32).fill(8);
const deviceSecret = new Uint8Array(32).fill(5);
const server = toBase64Url(new Uint8Array(32).fill(9));
const code = `shahi://pair#v=1&server=${server}&relay=https%3A%2F%2Frelay.example&secret=${toBase64Url(pairingSecret)}`;
/** Paths the fake computer receives and never answers. */
const holding = new Set<string>();

class FakeSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  box: Session | null = null;
  /** Still OPEN on this side, but nothing arrives at the other: a route that died quietly. */
  silent = false;
  paths: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
  }
  close() { this.readyState = 3; }
  send(data: Uint8Array) {
    if (this.silent || this.readyState !== 1) return;
    if (!this.box) {
      const hello = JSON.parse(utf8.decode(data)) as { pub: string; auth: { kind: string } };
      const self = ephemeral(new Uint8Array(32).fill(3));
      this.box = serverSession(self, fromBase64Url(hello.pub), hello.auth.kind === "pairing" ? pairingSecret : deviceSecret);
      queueMicrotask(() => this.deliver(utf8.encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(self.pub) }))));
      return;
    }
    const message = JSON.parse(utf8.decode(open(this.box, data))) as { t: string; id: number; path: string };
    if (message.t !== "req") return;
    this.paths.push(message.path);
    if (holding.has(message.path)) return;
    const body = message.path === "/api/meta" ? { serverId: server }
      : message.path === "/api/pair/claim" ? { deviceId: "browser-1", deviceSecret: toBase64Url(deviceSecret) } : {};
    queueMicrotask(() => this.reply({ t: "res", id: message.id, status: 200, headers: { "content-type": "application/json" }, body: toBase64Url(utf8.encode(JSON.stringify(body))) }));
  }
  reply(value: unknown) { if (!this.silent) this.deliver(seal(this.box!, utf8.encode(JSON.stringify(value)))); }
  deliver(bytes: Uint8Array) { if (this.readyState === 1) this.onmessage?.({ data: new Uint8Array(bytes).buffer }); }
}

const settle = () => Bun.sleep(5);
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { isSecureContext: true }),
    location: { origin: "https://getshahi.dev", hostname: "getshahi.dev" },
    WebSocket: FakeSocket,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  for (const computer of browserComputers()) await forgetBrowser(computer.id);
  holding.clear();
  FakeSocket.opened = [];
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
});

/** A paired, selected computer whose device link is live. */
async function paired() {
  await pairBrowser(code, "Browser test", false);
  await settle();
  const device = FakeSocket.opened.at(-1)!;
  expect(browserConnection().link?.state).toBe("live");
  return device;
}

/** The dashboard's subscription, shaped as App.tsx makes it: refresh when the link is lost. */
function dashboard() {
  const owner = browserConnection();
  const scoped = createApi(() => owner);
  const active = () => owner.generation === browserConnection().generation;
  const seen = { refreshes: 0 };
  const socket = new SessionSocket(() => {}, (state) => {
    if (!active()) return;
    if (state === "lost") { seen.refreshes++; void scoped.session().catch(() => {}); }
  });
  socket.connect();
  return { socket, scoped, seen };
}

test("signing out of the selected computer does not reopen its relay link", async () => {
  await paired();
  const { socket, seen } = dashboard();
  const before = FakeSocket.opened.length;
  await forgetBrowser();
  await settle();
  // The refresh the dashboard sends on "lost" is what used to reopen the link.
  expect(seen.refreshes).toBe(0);
  expect(FakeSocket.opened.length).toBe(before);
  socket.close();
});

test("a computer ending this browser's pairing does not leave its link redialling the relay", async () => {
  const device = await paired();
  const { socket } = dashboard();
  const before = FakeSocket.opened.length;
  // Revocation reaches the link as a sealed bye; the link closes before the
  // app has forgotten the computer, so the dashboard still hears "lost".
  device.reply({ t: "bye" });
  await settle();
  expect(browserComputers()).toHaveLength(0);
  expect(FakeSocket.opened.length).toBe(before);
  socket.close();
});

test("returning to the tab keeps a healthy relay link and the agent start in flight through it", async () => {
  const device = await paired();
  holding.add("/api/agents/start");
  let outcome = "pending";
  createApi(browserConnection).startAgent("w1", "/home/me/project", null, "claude", "agent")
    .then(() => { outcome = "resolved"; }, (error: Error) => { outcome = `rejected: ${error.message}`; });
  await settle();
  const before = FakeSocket.opened.length;
  resumeComputers();
  await settle();
  expect(outcome).toBe("pending");
  expect(FakeSocket.opened.length).toBe(before);
  expect(browserConnection().link?.state).toBe("live");
  expect(device.paths.at(-1)).toBe("/api/meta");
});

test("returning to the tab replaces a relay link that died without closing", async () => {
  const device = await paired();
  device.silent = true;
  const before = FakeSocket.opened.length;
  resumeComputers(20);
  const deadline = Date.now() + 1000;
  while (FakeSocket.opened.length === before && Date.now() < deadline) await settle();
  expect(FakeSocket.opened.length).toBe(before + 1);
});

test("returning to the tab replaces a relay link whose socket already closed", async () => {
  const device = await paired();
  // A suspended page can miss the close event; the socket state still says so.
  device.readyState = 3;
  const before = FakeSocket.opened.length;
  resumeComputers();
  await settle();
  expect(FakeSocket.opened.length).toBe(before + 1);
});


test("a computer's live snapshots forget a replaced occupant's draft without a mounted dashboard", async () => {
  const device = await paired();
  const identity = browserConnection().identity!;
  const snapshot = (instanceId: string) => ({ version: "test", panes: [{ paneId: "w1:p1", instanceId, isAgent: true, status: "blocked" }], workspaces: [], tabs: [], serverName: "Laptop" });
  device.reply({ t: "ws", data: { type: "session", session: snapshot("old") } });
  await settle();
  const draft = webDraft(draftOwner(identity), "w1:p1");
  draft.text = "must not go to the replacement";
  device.reply({ t: "ws", data: { type: "session", session: snapshot("new") } });
  await settle();
  expect(webDraft(draftOwner(identity), "w1:p1").text).toBe("");
});
