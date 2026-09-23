/**
 * A saved SSH computer, end to end in the app: restore, reconnect, re-add, a
 * changed server key and removal.
 *
 * Everything below the network is real — SessionProvider, ComputerSession,
 * the api client, `lib/tunnel`, the Keychain helper and, for the reader, the
 * Pane itself. What is faked is what a phone cannot have in a test: the native
 * SSH module (modelled on SshTunnelModule.swift, which replaces a forward
 * already open under the same id), a sidecar behind the forwarded ports that
 * checks cookies the way server/lib/http.ts does, the WebSocket, and the
 * Keychain's storage.
 */
import { act, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type { SshProfile } from "./ssh";

jest.setTimeout(30_000);

jest.mock("expo", () => {
  const forwards = new Map<string, number>();
  let port = 51000;
  const sshTunnel = {
    forwards,
    opening: null as null | Promise<void>,
    hostKey: jest.fn(),
    open: jest.fn(async ({ id }: { id: string }) => {
      await sshTunnel.opening;
      forwards.delete(id); forwards.set(id, ++port);
      return { localPort: port };
    }),
    close: jest.fn(async (id: string) => { forwards.delete(id); }),
  };
  return { ...jest.requireActual("expo"), requireOptionalNativeModule: (name: string) => (name === "SshTunnel" ? sshTunnel : null) };
});
// The reader's own surroundings, as pane.test.tsx has them.
jest.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("@/lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));

import { requireOptionalNativeModule } from "expo";
import { SessionProvider, useSession } from "./session";
import { COMPUTERS_KEY, computerId, type SavedComputer } from "./computers";
import { connection } from "./api";
import { openTunnel } from "./tunnel";
import { Pane } from "@/screens/pane";
import { ConnectionHealth } from "@/components/connection-health";

const native = requireOptionalNativeModule("SshTunnel") as unknown as {
  forwards: Map<string, number>; opening: null | Promise<void>; open: jest.Mock; close: jest.Mock;
};

const profile: SshProfile = { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "2468", auth: { kind: "password", password: "fake" } };
const saved: SavedComputer = { id: computerId({ kind: "ssh", ssh: profile }), name: "Box", connection: { kind: "ssh", ssh: profile }, pins: [] };
const PIN = "shahi.knownhost.box.example_22";

/** The sidecar behind every live forward. */
const sidecar = { cookies: new Set<string>(), issued: 0, login: null as null | Promise<void> };
function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}
const snapshot = { version: "0.9.1", protocol: 22, workspaces: [], tabs: [], panes: [{ paneId: "w1:p1", title: "A task", agent: "claude", isAgent: true }] };
const transcript = { sessionId: "s1", path: "/home/x/s1.jsonl", total: 1, offset: 0, messages: [{ id: "a1", role: "agent", at: 1, blocks: [{ kind: "text", text: "hello from the agent" }] }] };
async function fakeFetch(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const target = new URL(url);
  if (![...native.forwards.values()].includes(Number(target.port))) throw new TypeError("Could not connect to the server.");
  const path = decodeURIComponent(target.pathname);
  const authed = !!init.headers?.cookie && sidecar.cookies.has(init.headers.cookie);
  if (path === "/api/meta") return reply(200, { api: { min: 5, max: 5 }, serverId: "ssh-box-id" });
  if (path === "/api/auth/status") return reply(200, { required: true, authenticated: authed });
  if (path === "/api/auth/login") {
    await sidecar.login;
    const cookie = `shahi_session=c${++sidecar.issued}`;
    sidecar.cookies.add(cookie);
    return reply(200, { ok: true }, { "set-cookie": `${cookie}; Path=/; HttpOnly` });
  }
  if (!authed) return reply(401, { error: "unauthorized" });
  if (path === "/api/session") return reply(200, snapshot);
  if (path === "/api/panes/w1:p1/session") return reply(200, transcript);
  if (path === "/api/panes/w1:p1") return reply(200, { frame: null, layout: null });
  return reply(404, { error: "not found" });
}

class FakeSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.opened.push(this); }
  send() {}
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1006 });
  }
}

const store = new Map<string, string>();
const bank = (): SavedComputer[] => JSON.parse(store.get(COMPUTERS_KEY) ?? "[]");
let value: ReturnType<typeof useSession>;
function Probe({ reader = false, health = false }: { reader?: boolean; health?: boolean }) {
  value = useSession();
  if (health) return <ConnectionHealth />;
  return reader && value.connected ? <Pane paneId="w1:p1" /> : null;
}
async function mount(reader = false, health = false) {
  const ui = render(<SessionProvider><Probe reader={reader} health={health} /></SessionProvider>);
  await waitFor(() => expect(value.ready).toBe(true));
  return ui;
}
async function live() {
  await waitFor(() => expect(FakeSocket.opened.at(-1)?.readyState).toBe(0));
  act(() => { const ws = FakeSocket.opened.at(-1)!; ws.readyState = 1; ws.onopen?.(); });
  await waitFor(() => expect(value.link).toBe("live"));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
beforeEach(() => {
  jest.useFakeTimers();
  store.clear(); FakeSocket.opened = []; native.forwards.clear(); native.opening = null;
  sidecar.cookies.clear(); sidecar.issued = 0; sidecar.login = null;
  connection.baseUrl = ""; connection.cookie = null; connection.relay = null;
  store.set(COMPUTERS_KEY, JSON.stringify([saved]));
  store.set("shahi.connection", JSON.stringify(saved.connection));
  store.set(PIN, "cGlubmVkLWhvc3Qta2V5");
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => store.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, data: string) => { store.set(key, data); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => { store.delete(key); });
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  (globalThis as { fetch: unknown }).fetch = jest.fn(fakeFetch);
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  (globalThis as { fetch: unknown }).fetch = realFetch;
  jest.useRealTimers();
});

// The high-severity finding: a reader poll that lands while the computer signs
// in again after its tunnel died carries no cookie, and its 401 signed out —
// erasing the saved computer, SSH password and passcode with it.
test("a reader poll during an SSH re-login does not sign out or erase the saved computer", async () => {
  const ui = await mount(true);
  await live();
  expect(await screen.findByText("hello from the agent")).toBeTruthy();

  // The phone was locked and the tunnel died under it.
  act(() => { native.forwards.clear(); FakeSocket.opened.at(-1)!.close(); });
  await act(async () => { await Promise.resolve(); });
  const login = deferred(); sidecar.login = login.promise;
  let reconnecting!: Promise<void>;
  await act(async () => { reconnecting = value.reconnect(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(native.forwards.size).toBe(1);

  // The reader keeps polling through the login's bcrypt and round trip.
  const polls = (globalThis.fetch as jest.Mock).mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(3_000); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  const cookieless = (globalThis.fetch as jest.Mock).mock.calls.slice(polls)
    .filter(([url, init]) => String(url).includes("/api/panes/") && !init?.headers?.cookie);
  expect(cookieless.length).toBeGreaterThan(0);

  await act(async () => { login.resolve(); await reconnecting; });
  expect(value.connected).toBe(true);
  expect(value.computers.map(c => c.id)).toEqual([saved.id]);
  expect(bank().map(c => c.id)).toEqual([saved.id]);
  expect(store.has("shahi.connection")).toBe(true);
  expect(store.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
  ui.unmount();
});

test("a 401 for a cookie the server really refused still signs that computer out", async () => {
  const ui = await mount();
  await live();
  sidecar.cookies.clear();
  await act(async () => { await value.refresh(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(value.connected).toBe(false);
  expect(bank()).toEqual([]);
  ui.unmount();
});

test("re-adding a saved SSH computer keeps the tunnel Connect just opened", async () => {
  const ui = await mount();
  await live();
  const [first] = [...native.forwards.values()];

  // What Connect does: its own tunnel, its own login, then sign-in.
  let added!: string;
  await act(async () => { added = await openTunnel(profile); });
  connection.baseUrl = added; connection.cookie = "shahi_session=fresh"; sidecar.cookies.add("shahi_session=fresh");
  await act(async () => { value.signInSsh(profile); for (let i = 0; i < 20; i++) await Promise.resolve(); });

  expect([...native.forwards.values()]).toEqual([Number(added.split(":").at(-1))]);
  expect([...native.forwards.values()]).not.toContain(first);
  expect(value.transport.baseUrl).toBe(added);
  await act(async () => { await value.refresh(); });
  expect(value.error).toBeNull();
  ui.unmount();
});

// The server was reinstalled, so the saved computer refuses its new key before
// any login. That refusal said what to do, but the screen said "Reconnecting…"
// for good; seen on a simulator.
test("a saved SSH computer whose server key changed says to check its identity, not that it is reconnecting", async () => {
  native.open.mockImplementationOnce(async () => {
    throw Object.assign(new Error("ssh_host_key: This computer's host key has changed since you trusted it, so your login was not sent. (at ExpoModulesCore/Promise.swift:65)"), { code: "ssh_host_key" });
  });
  const ui = await mount(false, true);
  expect(await screen.findByText("Check this computer’s identity")).toBeTruthy();
  expect(screen.getByText(/host key has changed since you trusted it/)).toBeTruthy();
  expect(screen.queryByText(/Reconnecting/)).toBeNull();
  // Nothing about the saved login was thrown away on the way.
  expect(bank().map(c => c.id)).toEqual([saved.id]);
  expect(store.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
  ui.unmount();
});

test("signing out of an SSH computer forgets the host key it trusted", async () => {
  const ui = await mount();
  await live();
  await act(async () => { value.signOut(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(value.computers).toEqual([]);
  expect(store.has(PIN)).toBe(false);
  expect(native.forwards.size).toBe(0);
  ui.unmount();
});
