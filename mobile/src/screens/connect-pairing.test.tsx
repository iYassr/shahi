/**
 * Pairing by link while the app is already in use: another computer open, or
 * another link answered a moment ago.
 *
 * The screen, the api client, the link handler and `parsePairingUrl` are
 * real. Only the relay links are faked, one per credential target as
 * `lib/relay` keys them, so each test can see which computer every request
 * reached and whose link was closed. A box answers `/api/pair/claim` only for
 * the one-time secret it printed, as `server/lib/pairing.ts` does.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { getRandomBytes } from "expo-crypto";

interface MockLink {
  requests: Array<{ path: string; body: string }>;
  closed: boolean;
}
const mockLinks = new Map<object, MockLink>();
/** A box's `/api/meta` answer held back until the test lets it go, by serverId. */
const mockHeld = new Map<string, Promise<void>>();
/** What each box printed a code for: serverId → the secret it will accept. */
const mockBoxes = new Map<string, string>();
jest.mock("@/lib/relay", () => {
  const actual = jest.requireActual("@/lib/relay");
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body), bytes: async () => new Uint8Array(),
  });
  const link = (target: { serverId: string }): MockLink & { request: unknown; ensureConnected: () => void; close: () => void } => {
    const self = {
      requests: [] as MockLink["requests"], closed: false,
      ensureConnected() {}, close() { self.closed = true; },
      async request(req: { path: string; body: Uint8Array | null }) {
        const body = req.body ? new TextDecoder().decode(req.body) : "";
        self.requests.push({ path: req.path, body });
        if (req.path === "/api/meta") { await mockHeld.get(target.serverId); return reply(200, { serverId: target.serverId, api: { min: 5, max: 5 } }); }
        if (req.path === "/api/pair/claim") {
          const { secret } = JSON.parse(body) as { secret: string };
          if (mockBoxes.get(target.serverId) !== secret) return reply(401, { error: "That pairing code is not valid." });
          mockBoxes.delete(target.serverId);
          return reply(200, { ok: true, deviceId: `device-of-${target.serverId.slice(0, 4)}`, deviceSecret: "ZGV2aWNlLXNlY3JldA" });
        }
        return reply(404, { error: "not found" });
      },
    };
    return self;
  };
  return {
    ...actual,
    relayLink: (target: { serverId: string }) => {
      let existing = mockLinks.get(target);
      if (!existing) { existing = link(target); mockLinks.set(target, existing); }
      return existing;
    },
    closeRelay: (target: object) => { const found = mockLinks.get(target) as { close?: () => void } | undefined; found?.close?.(); },
  };
});
jest.mock("@/components/scanner", () => ({ Scanner: () => null }));
jest.mock("@/components/icons", () => ({ Logo: () => null, Wordmark: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-device", () => ({ deviceName: null, modelName: "iPhone" }));

import { Connect } from "./connect";
import { connection } from "@/lib/api";
import { relayLink, toBase64Url, type RelayTarget } from "@/lib/relay";
import { redirectSystemPath } from "../app/+native-intent";
import { dismissPairing } from "@/lib/incoming-pairing";

/** A box that has just printed a code; the id ends in a character a 32-byte id can end in. */
function printedCode(name: string) {
  const serverId = `${name.padEnd(42, "x")}A`;
  const secret = toBase64Url(getRandomBytes(32));
  mockBoxes.set(serverId, secret);
  return { serverId, secret, url: `shahi://pair#v=1&server=${serverId}&relay=${encodeURIComponent("https://relay.getshahi.dev")}&secret=${secret}` };
}
function open(url: string) {
  act(() => { expect(redirectSystemPath({ path: url, initial: false })).toBe("/connect"); });
}
const linkTo = (serverId: string) => [...mockLinks.entries()].find(([target]) => (target as RelayTarget).serverId === serverId)?.[1];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

beforeEach(() => {
  mockLinks.clear(); mockBoxes.clear(); mockHeld.clear(); dismissPairing();
  connection.baseUrl = ""; connection.cookie = null; connection.relay = null;
});

// With computer A open and pushing, a link for B sent B's one-time secret to
// A: the session copies the open computer's connection into the shared one on
// every message, and Connect paired through that shared connection. The claim
// failed as "not valid", and A's link was closed under it (pre-release bug hunt).
test("pairing a second computer by link never sends its code to the computer that is open", async () => {
  const open_ = printedCode("computer-a");
  mockBoxes.delete(open_.serverId);
  const openComputer = { relay: "https://relay.getshahi.dev", serverId: open_.serverId, auth: { kind: "device", deviceId: "a" }, secret: new Uint8Array(32) } as RelayTarget;
  relayLink(openComputer);
  connection.relay = openComputer;

  const b = printedCode("computer-b");
  const onConnectedRelay = jest.fn();
  open(b.url);
  render(<Connect onConnectedSsh={jest.fn()} onConnectedRelay={onConnectedRelay} />);
  const metaHeld = deferred();
  mockHeld.set(b.serverId, metaHeld.promise);
  fireEvent.press(screen.getByTestId("confirm-pair"));
  await waitFor(() => expect(linkTo(b.serverId)?.requests.map(r => r.path)).toEqual(["/api/meta"]));

  // What SessionProvider does with each message the open computer pushes.
  act(() => { Object.assign(connection, { baseUrl: "", cookie: null, relay: openComputer }); });
  await act(async () => { metaHeld.resolve(); });

  await waitFor(() => expect(onConnectedRelay).toHaveBeenCalledWith(expect.objectContaining({ serverId: b.serverId })));
  expect(mockLinks.get(openComputer)?.requests).toEqual([]);
  expect(mockLinks.get(openComputer)?.closed).toBe(false);
  expect(linkTo(b.serverId)?.requests.map(r => r.path)).toEqual(["/api/meta", "/api/pair/claim"]);
  expect(JSON.parse(linkTo(b.serverId)!.requests[1]!.body)).toEqual(expect.objectContaining({ secret: b.secret }));
  // The pairing link is done with once the device exists.
  expect(linkTo(b.serverId)?.closed).toBe(true);
  expect(screen.queryByText(/not valid/)).toBeNull();
});

test("a second pairing link does not inherit the first one's error", async () => {
  const spent = printedCode("spent-box");
  mockBoxes.delete(spent.serverId);
  const onConnectedRelay = jest.fn();
  open(spent.url);
  render(<Connect onConnectedSsh={jest.fn()} onConnectedRelay={onConnectedRelay} />);
  fireEvent.press(screen.getByTestId("confirm-pair"));
  expect(await screen.findByText(/That pairing code is not valid/)).toBeTruthy();

  // A fresh code for another computer, opened without tapping Cancel.
  const fresh = printedCode("fresh-box");
  open(fresh.url);
  expect(await screen.findByText(`${fresh.serverId.slice(0, 16)}…`)).toBeTruthy();
  expect(screen.queryByText(/not valid/)).toBeNull();

  fireEvent.press(screen.getByTestId("confirm-pair"));
  await waitFor(() => expect(onConnectedRelay).toHaveBeenCalledWith(expect.objectContaining({ serverId: fresh.serverId })));
});

// The same, in the other order: the first code fails after the second card is
// already showing. That failure is the first code's, not the new card's, and
// the new card must stay until it is answered itself.
test("a pairing that fails after a newer link arrived leaves the newer card clean and waiting", async () => {
  const spent = printedCode("slow-spent");
  mockBoxes.delete(spent.serverId);
  const held = deferred();
  mockHeld.set(spent.serverId, held.promise);
  open(spent.url);
  render(<Connect onConnectedSsh={jest.fn()} onConnectedRelay={jest.fn()} />);
  fireEvent.press(screen.getByTestId("confirm-pair"));
  await waitFor(() => expect(linkTo(spent.serverId)?.requests).toHaveLength(1));

  const fresh = printedCode("newer-box");
  open(fresh.url);
  await act(async () => { held.resolve(); });
  await waitFor(() => expect(linkTo(spent.serverId)?.closed).toBe(true));

  expect(screen.getByText(`${fresh.serverId.slice(0, 16)}…`)).toBeTruthy();
  expect(screen.queryByText(/not valid/)).toBeNull();
  expect(screen.getByText("Pair with this computer")).toBeTruthy();
});
