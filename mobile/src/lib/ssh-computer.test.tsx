/**
 * A saved SSH computer, end to end in the app: restore, reconnect, re-add, a
 * changed server key, notifications and removal.
 *
 * Everything below the network is real — SessionProvider, ComputerSession,
 * the api client, `lib/tunnel`, the Keychain helper and, for the reader, the
 * Pane itself. What is faked is what a phone cannot have in a test: the native
 * SSH module (modelled on SshTunnelModule.swift, which replaces a forward
 * already open under the same id), a sidecar behind the forwarded ports that
 * checks cookies the way server/lib/http.ts does, the WebSocket, and the
 * Keychain's storage.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
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
import { pushKeyFor } from "./push-registration";
import { Pane } from "@/screens/pane";
import { ConnectionHealth } from "@/components/connection-health";
import { HostKeyCard } from "@/components/host-key-card";

const native = requireOptionalNativeModule("SshTunnel") as unknown as {
  forwards: Map<string, number>; opening: null | Promise<void>; open: jest.Mock; close: jest.Mock; hostKey: jest.Mock;
};

/** The fake's own forward-opening, restored before each test that replaces it. */
const openForward = native.open.getMockImplementation()!;

const profile: SshProfile = { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "2468", auth: { kind: "password", password: "fake" } };
const saved: SavedComputer = { id: computerId({ kind: "ssh", ssh: profile }), name: "Box", connection: { kind: "ssh", ssh: profile }, pins: [] };
const PIN = "shahi.knownhost.box.example_22";

/** The sidecar behind every live forward. */
const sidecar = { cookies: new Set<string>(), issued: 0, logins: 0, login: null as null | Promise<void>, passcode: "2468", control: false, pushes: [] as { cookie?: string; token: string }[] };
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
const handshake = {
  control: 1, serverId: "ssh-box-id", api: { min: 5, max: 5 }, capabilities: ["computer-updates"],
  backend: { state: "connected", version: "0.9.1", protocol: 22 }, update: { managed: true, channel: "stable", phase: "idle", current: "0.3.0" },
};
async function fakeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const target = new URL(url);
  if (![...native.forwards.values()].includes(Number(target.port))) throw new TypeError("Could not connect to the server.");
  const path = decodeURIComponent(target.pathname);
  const authed = !!init.headers?.cookie && sidecar.cookies.has(init.headers.cookie);
  if (path === "/api/meta") return reply(200, { api: { min: 5, max: 5 }, serverId: "ssh-box-id", ...(sidecar.control && { control: 1 }) });
  if (path === "/api/auth/status") return reply(200, { required: true, authenticated: authed });
  if (path === "/api/auth/login") {
    sidecar.logins++;
    await sidecar.login;
    if ((JSON.parse(init.body ?? "{}") as { passcode?: string }).passcode !== sidecar.passcode) return reply(401, { error: "unauthorized" });
    const cookie = `shahi_session=c${++sidecar.issued}`;
    sidecar.cookies.add(cookie);
    return reply(200, { ok: true }, { "set-cookie": `${cookie}; Path=/; HttpOnly` });
  }
  if (!authed) return reply(401, { error: "unauthorized" });
  if (path === "/api/session") return reply(200, snapshot);
  if (path === "/api/push/expo") { sidecar.pushes.push({ cookie: init.headers?.cookie, token: JSON.parse(init.body ?? "{}").token }); return reply(200, { ok: true }); }
  if (path === "/api/control/handshake" && sidecar.control) return reply(200, handshake);
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

/** This build's own keychain service, and the default one builds up to TestFlight 15 wrote. */
const store = new Map<string, string>();
const earlier = new Map<string, string>();
const bank = (): SavedComputer[] => JSON.parse(store.get(COMPUTERS_KEY) ?? "[]");
let value: ReturnType<typeof useSession>;
function Probe({ reader = false, health = false }: { reader?: boolean; health?: boolean }) {
  value = useSession();
  // What the root layout shows over every screen.
  if (value.hostKeyReview) return <HostKeyCard review={value.hostKeyReview.review} answer={value.hostKeyReview.answer} />;
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
  sidecar.cookies.clear(); sidecar.issued = 0; sidecar.logins = 0; sidecar.login = null; sidecar.passcode = "2468"; sidecar.control = false; sidecar.pushes = [];
  native.open.mockReset(); native.open.mockImplementation(openForward);
  connection.baseUrl = ""; connection.cookie = null; connection.relay = null;
  store.set(COMPUTERS_KEY, JSON.stringify([saved]));
  store.set("shahi.connection", JSON.stringify(saved.connection));
  store.set(PIN, "cGlubmVkLWhvc3Qta2V5");
  earlier.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string, options?: object) => (options ? store : earlier).get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, data: string, options?: object) => { (options ? store : earlier).set(key, data); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string, options?: object) => { (options ? store : earlier).delete(key); });
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

async function settle(ms = 0) {
  await act(async () => { jest.advanceTimersByTime(ms); for (let i = 0; i < 30; i++) await Promise.resolve(); });
}

// The session cookie outlived (30 days by default, or a SESSION_SECRET
// rotation): the heartbeat closed the socket with 4001 and the computer was
// forgotten — SSH login, passcode and trusted host key erased without a word —
// although the saved passcode still signed in (pre-release bug hunt).
test("an SSH computer whose session cookie expired signs in again with its saved passcode instead of being erased", async () => {
  const ui = await mount();
  await live();
  expect(sidecar.logins).toBe(1);

  sidecar.cookies.clear();
  act(() => { FakeSocket.opened.at(-1)!.close(4001); });
  await settle();
  await waitFor(() => expect(sidecar.logins).toBe(2));
  await live();

  expect(value.connected).toBe(true);
  expect(value.error).toBeNull();
  expect(bank().map(c => c.id)).toEqual([saved.id]);
  expect(store.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
  ui.unmount();
});

test("a 401 for a cookie the server really refused signs in again rather than signing out", async () => {
  const ui = await mount();
  await live();
  sidecar.cookies.clear();
  await act(async () => { await value.refresh(); });
  await settle();
  await waitFor(() => expect(sidecar.logins).toBe(2));
  expect(value.connected).toBe(true);
  expect(bank().map(c => c.id)).toEqual([saved.id]);
  ui.unmount();
});

// The passcode was reset on the computer. The saved one is refused; the
// computer stays, says so, and is not signed in with the same passcode again
// on a timer.
test("a saved SSH computer whose passcode changed is kept, says so, and is not retried on its own", async () => {
  const ui = await mount(false, true);
  await live();
  sidecar.cookies.clear(); sidecar.passcode = "1357";
  act(() => { FakeSocket.opened.at(-1)!.close(4001); });
  expect(await screen.findByText("Couldn’t sign in")).toBeTruthy();
  expect(screen.getByText(/box\.example no longer accepts the Shahi passcode saved for it/)).toBeTruthy();
  const attempts = sidecar.logins;
  await settle(120_000);
  expect(sidecar.logins).toBe(attempts);
  expect(bank().map(c => c.id)).toEqual([saved.id]);
  expect(store.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
  ui.unmount();
});

// sshd restarted, the box rebooted, a NAT forgot the connection: the socket
// retried the dead local forward for over three minutes while the card said
// "retrying", and no attempt ever reached the SSH server; only Retry, the
// foreground or a network change reopened the tunnel (pre-release bug hunt).
test("an SSH computer whose SSH session died reconnects by itself, backing off while the server is down", async () => {
  const ui = await mount();
  await live();
  expect(native.open).toHaveBeenCalledTimes(1);

  // The session is gone, and so is the server for a while.
  native.open.mockRejectedValue(Object.assign(new Error("ssh_tunnel: Could not reach box.example:22."), { code: "ssh_tunnel" }));
  act(() => { native.forwards.clear(); FakeSocket.opened.at(-1)!.close(); });
  await settle();
  expect(value.link).toBe("lost");

  await settle(1_000);
  expect(native.open).toHaveBeenCalledTimes(2);
  await settle(1_999);
  expect(native.open).toHaveBeenCalledTimes(2);
  await settle(1);
  expect(native.open).toHaveBeenCalledTimes(3);

  // Back up: the next attempt, four seconds on, is live again.
  native.open.mockImplementation(openForward);
  await settle(4_000);
  expect(native.open).toHaveBeenCalledTimes(4);
  await live();
  expect(value.error).toBeNull();
  ui.unmount();
});

// A reopened tunnel costs an SSH login and a Shahi sign-in; an error the
// sidecar answered with came through a tunnel that works.
test("an error the computer answered with does not reopen a working SSH tunnel", async () => {
  const ui = await mount();
  await live();
  const answered = (globalThis.fetch as jest.Mock).getMockImplementation()!;
  (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init: never) =>
    String(url).endsWith("/api/session") ? reply(503, { error: "herdr is not running" }) : answered(url, init));
  await act(async () => { await value.refresh(); });
  expect(value.error?.message).toBe("herdr is not running");
  // Two minutes, with the server's heartbeat keeping the socket alive.
  for (let s = 0; s < 12; s++) {
    act(() => { FakeSocket.opened.at(-1)!.onmessage?.({ data: JSON.stringify({ type: "ping" }) }); });
    await settle(10_000);
  }
  expect(native.open).toHaveBeenCalledTimes(1);
  ui.unmount();
});

test.each([
  ["a host key that does not match", { code: "ssh_host_key", message: "ssh_host_key: This computer's host key has changed since you trusted it, so your login was not sent." }],
  ["a refused SSH login", { code: "ssh_login", message: "ssh_login: Authentication failed — check the username and credentials." }],
  ["a server that will not forward a port", { code: "ssh_forwarding", message: "ssh_forwarding: Signed in to box.example, but its SSH server does not allow port forwarding, which Shahi needs." }],
])("%s is not retried on a timer", async (_, refusal) => {
  native.open.mockRejectedValue(Object.assign(new Error(refusal.message), { code: refusal.code }));
  const ui = await mount();
  await settle();
  expect(native.open).toHaveBeenCalledTimes(1);
  await settle(120_000);
  expect(native.open).toHaveBeenCalledTimes(1);
  ui.unmount();
});

// The card that manages updates kept polling after its tunnel was cleared,
// fetched "/api/meta" with no address, and showed that every two seconds.
test("a tunnel that cannot be reopened never puts an internal address error on the This computer card", async () => {
  sidecar.control = true;
  const ui = await mount();
  await live();
  await waitFor(() => expect(value.control?.handshake?.serverId).toBe("ssh-box-id"));

  native.open.mockRejectedValue(Object.assign(new Error("ssh_host_key: This computer's host key has changed since you trusted it, so your login was not sent."), { code: "ssh_host_key" }));
  act(() => { native.forwards.clear(); FakeSocket.opened.at(-1)!.close(); });
  await act(async () => { await value.reconnect(); });
  // Past the poll's healthy interval, and several of its two-second retries.
  for (let s = 0; s < 40; s++) await settle(1_000);

  const relative = (globalThis.fetch as jest.Mock).mock.calls.filter(([url]) => !/^https?:/.test(String(url)));
  expect(relative).toEqual([]);
  expect(value.control?.error ?? "").not.toMatch(/full address/);
  ui.unmount();
});

// Failures used to name this phone's end of the tunnel, a random port on
// 127.0.0.1: "The connection to 127.0.0.1:54119 dropped mid-request".
test("an SSH computer's dropped tunnel is described by its SSH host, not the phone's local port", async () => {
  const ui = await mount();
  await live();
  act(() => { native.forwards.clear(); });
  await act(async () => { await value.refresh(); });
  expect(value.error?.message).toMatch(/box\.example/);
  expect(value.error?.message).not.toMatch(/127\.0\.0\.1/);
  ui.unmount();
});

test("re-adding a saved SSH computer keeps the tunnel Connect just opened", async () => {
  const ui = await mount();
  await live();
  const [first] = [...native.forwards.values()];

  // What Connect does: its own tunnel, its own login, then sign-in.
  let added!: string;
  await act(async () => { added = await openTunnel(profile); });
  sidecar.cookies.add("shahi_session=fresh");
  await act(async () => { value.signInSsh(profile, { baseUrl: added, cookie: "shahi_session=fresh", relay: null }); for (let i = 0; i < 20; i++) await Promise.resolve(); });

  expect([...native.forwards.values()]).toEqual([Number(added.split(":").at(-1))]);
  expect([...native.forwards.values()]).not.toContain(first);
  expect(value.transport.baseUrl).toBe(added);
  await act(async () => { await value.refresh(); });
  expect(value.error).toBeNull();
  ui.unmount();
});

test("an SSH computer's server id is known on a cold launch, before its tunnel is up", async () => {
  let ui = await mount();
  await live();
  await waitFor(() => expect(bank()[0]?.serverId).toBe("ssh-box-id"));
  ui.unmount();

  // Cold launch from a notification tap: the tunnel takes its time.
  native.opening = new Promise(() => {});
  ui = await mount();
  expect(value.link).not.toBe("live");
  expect(value.computers).toEqual([expect.objectContaining({ id: saved.id, serverId: "ssh-box-id" })]);
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

// The server ends a passcode session's notifications when the session does,
// and an SSH computer signs in afresh on every launch and every new tunnel.
// Carried only by Connect's sign-in, a phone's notifications would stop once
// the session that turned them on ran out.
test("an SSH computer's notifications follow it into every session it signs in with", async () => {
  store.set(pushKeyFor(saved.connection)!, "ExponentPushToken[phone]");
  const ui = await mount();
  await live();
  await waitFor(() => expect(sidecar.pushes).toEqual([{ cookie: "shahi_session=c1", token: "ExponentPushToken[phone]" }]));

  // The phone was locked and the tunnel died under it.
  act(() => { native.forwards.clear(); FakeSocket.opened.at(-1)!.close(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await value.reconnect(); });
  await waitFor(() => expect(sidecar.pushes.map((p) => p.cookie)).toEqual(["shahi_session=c1", "shahi_session=c2"]));

  // A refresh on the same session carries nothing again.
  await act(async () => { await value.refresh(); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(sidecar.pushes).toHaveLength(2);
  ui.unmount();
});

test("an SSH computer that never turned notifications on registers nothing", async () => {
  const ui = await mount();
  await live();
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(sidecar.pushes).toEqual([]);
  ui.unmount();
});

// TestFlight installs an older build over a newer one, and it saves only to
// the default keychain service. A computer it added was missing when this
// build returned (pre-release bug hunt).
test("a computer an earlier build added after a downgrade is listed beside this build's own", async () => {
  const other: SavedComputer = { ...saved, id: computerId({ kind: "ssh", ssh: { ...profile, host: "other.example" } }), name: "Other", connection: { kind: "ssh", ssh: { ...profile, host: "other.example" } } };
  earlier.set(COMPUTERS_KEY, JSON.stringify([other]));
  const ui = await mount();
  expect(value.computers.map(c => c.name).sort()).toEqual(["Box", "Other"]);
  await waitFor(() => expect(bank().map(c => c.id).sort()).toEqual([saved.id, other.id].sort()));
  expect(earlier.has(COMPUTERS_KEY)).toBe(false);
  ui.unmount();
});

// Builds up to TestFlight 15 pinned the first key they met without showing
// it, and this build carried such pins over as reviewed: a saved computer
// relied on one at once, and its review never happened (pre-release bug hunt).
describe("a saved computer whose key an earlier version trusted unseen", () => {
  beforeEach(() => {
    store.delete(PIN); earlier.set(PIN, "cGlubmVkLWhvc3Qta2V5");
    native.hostKey.mockReset(); native.hostKey.mockResolvedValue({ hostKey: "cGlubmVkLWhvc3Qta2V5", keyType: "ED25519" });
  });

  test("shows that key once before sending a login, and trusts it from then on", async () => {
    const ui = await mount(false, true);
    expect(await screen.findByText(/An earlier version of Shahi trusted this key for box\.example without showing it to you/)).toBeTruthy();
    expect(screen.getByTestId("host-key-fingerprint").props.children).toBe("SHA256:cGlubmVkLWhvc3Qta2V5");
    expect(native.open).not.toHaveBeenCalled();
    expect(sidecar.logins).toBe(0);

    act(() => { fireEvent.press(screen.getByTestId("trust-host-key")); });
    await live();
    expect(native.open).toHaveBeenCalledWith(expect.objectContaining({ expectedHostKey: "cGlubmVkLWhvc3Qta2V5" }));
    expect(store.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
    expect(earlier.has(PIN)).toBe(false);

    // Reviewed now: the next reconnect neither asks nor probes.
    act(() => { native.forwards.clear(); FakeSocket.opened.at(-1)!.close(); });
    await act(async () => { await value.reconnect(); });
    await live();
    expect(native.hostKey).toHaveBeenCalledTimes(1);
    expect(value.hostKeyReview).toBeNull();
    ui.unmount();
  });

  test("declining sends nothing, keeps the computer, and is not asked again on a timer", async () => {
    const ui = await mount(false, true);
    act(() => { fireEvent.press(screen.getByTestId("reject-host-key")); });
    expect(await screen.findByText("Check this computer’s identity")).toBeTruthy();
    expect(screen.getByText("Not connected. Nothing was sent to that computer.")).toBeTruthy();
    await settle(120_000);
    expect(value.hostKeyReview).toBeNull();
    expect(native.hostKey).toHaveBeenCalledTimes(1);
    expect(native.open).not.toHaveBeenCalled();
    expect(sidecar.logins).toBe(0);
    expect(bank().map(c => c.id)).toEqual([saved.id]);
    expect(earlier.get(PIN)).toBe("cGlubmVkLWhvc3Qta2V5");
    ui.unmount();
  });
});
