/**
 * The provider's restore of a relay connection.
 *
 * A cold start with a relay entry in the keychain must come up as a device
 * on the box's link, not on an address: the hello says the stored device id,
 * the first request goes through that link, and Settings names the relay.
 * Everything below the provider is real — `api`, the transport, `e2e.ts` —
 * with the socket faked the way `relay.test.ts` fakes it.
 */
import { Text } from "react-native";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { RELAY_PROTOCOL, type PhoneHello, type RelayRequest } from "@shahi/shared";
import { ephemeral, open, seal, serverSession, type Session } from "../../../shared/src/e2e";
import { SessionProvider, useSession } from "./session";
import { closeRelay, fromBase64Url, toBase64Url } from "./relay";
import { connection } from "./api";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

class FakeSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005 });
  }
}

const stored = {
  kind: "relay",
  relay: "https://relay.example.dev",
  serverId: "Zm9v-bar_baz",
  deviceId: "dev-1",
  deviceSecret: toBase64Url(random(32)),
};

function Probe() {
  const { connected, server, link, session } = useSession();
  return (
    <>
      <Text testID="connected">{String(connected)}</Text>
      <Text testID="server">{server}</Text>
      <Text testID="link">{link}</Text>
      <Text testID="panes">{session ? String(session.panes.length) : "none"}</Text>
    </>
  );
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.opened = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) =>
    key === "shahi.connection" ? JSON.stringify(stored) : null,
  );
});
afterEach(() => {
  closeRelay();
  connection.relay = null;
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async () => null);
});

test("a remembered relay connection comes back as that device, through the relay, with the relay named in Settings", async () => {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );

  // Restore points the connection at the box; the first request opens the link.
  await waitFor(() => expect(screen.getByTestId("connected").props.children).toBe("true"));
  expect(screen.getByTestId("server").props.children).toBe("relay://relay.example.dev");
  expect(connection.relay).toMatchObject({ serverId: "Zm9v-bar_baz", auth: { kind: "device", deviceId: "dev-1" } });
  expect(connection.baseUrl).toBe("");
  await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
  const ws = FakeSocket.opened[0]!;
  expect(ws.url).toBe("wss://relay.example.dev/v1/phone/Zm9v-bar_baz");

  // The box greets, keyed from the same device secret the keychain held.
  ws.readyState = 1;
  act(() => ws.onopen?.());
  // Bytes, not text: the relay forwards data frames and drops phone text.
  const hello = JSON.parse(new TextDecoder().decode(ws.sent[0] as Uint8Array)) as PhoneHello;
  expect(hello.auth).toEqual({ kind: "device", deviceId: "dev-1" });
  const self = ephemeral(random(32));
  const box: Session = serverSession(self, fromBase64Url(hello.pub), fromBase64Url(stored.deviceSecret));
  act(() =>
    ws.onmessage?.({ data: new TextEncoder().encode(JSON.stringify({ t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(self.pub) })).buffer }),
  );
  await waitFor(() => expect(screen.getByTestId("link").props.children).toBe("live"));

  // The session read that restore triggers went through the link, sealed —
  // and the answer lands in the mirror.
  await waitFor(() => expect(ws.sent.length).toBeGreaterThan(2));
  const proof = JSON.parse(new TextDecoder().decode(open(box, ws.sent[1] as Uint8Array)));
  expect(proof).toEqual({ t: "ws", data: { type: "unwatch" } });
  const req = JSON.parse(new TextDecoder().decode(open(box, ws.sent[2] as Uint8Array))) as RelayRequest;
  expect(req).toMatchObject({ t: "req", method: "GET", path: "/api/session" });
  const snapshot = {
    version: "0.8.2",
    protocol: 20,
    defaultGrouping: "workspace",
    focusedPaneId: null,
    workspaces: [],
    tabs: [],
    panes: [{ paneId: "w1:p1" }],
  };
  const res = { t: "res", id: req.id, status: 200, headers: { "content-type": "application/json" }, body: toBase64Url(new TextEncoder().encode(JSON.stringify(snapshot))) };
  act(() => ws.onmessage?.({ data: seal(box, new TextEncoder().encode(JSON.stringify(res))).slice().buffer }));
  await waitFor(() => expect(screen.getByTestId("panes").props.children).toBe("1"));
});
