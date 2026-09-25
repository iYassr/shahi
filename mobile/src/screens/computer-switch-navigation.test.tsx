/**
 * After a change of computer, no pane of the previous computer is left on the
 * stack, and none is ever resolved against the new one.
 *
 * herdr numbers panes `w1:p1`, `w1:p2`… on every computer. The pre-release bug
 * hunt opened `w1:p3` on one computer, moved to another by a notification, a
 * pairing link or the switcher, pressed Back and found the other computer's
 * `w1:p3` with a live composer: the send landed in that computer's shell, and
 * the leftover pane polled it every 2.5s underneath the list. The real root
 * layout, router, pane route, Computers and Connect run here against the real
 * expo-router; only the session is a two-computer fake whose API records
 * which computer each request went to.
 */
import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { router, Slot } from "expo-router";

let mockTap: ((paneId: string, serverId?: string) => void) | null = null;
let mockPairing: object | null = null;
const mockCalls: string[] = [];
const mockSession: { switchComputer?: (id: string) => Promise<void>; signInRelay?: () => void } = {};

jest.mock("@/lib/push", () => ({
  onNotificationTapped: (open: (paneId: string, serverId?: string) => void) => { mockTap = open; return () => { mockTap = null; }; },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: ({ children }: { children: unknown }) => children }));
jest.mock("@/lib/incoming-pairing", () => ({ usePendingPairing: () => mockPairing }));
jest.mock("@/screens/connect", () => {
  const { Button } = require("react-native");
  return { Connect: ({ onConnectedRelay }: { onConnectedRelay: () => void }) => <Button title="Pair Beta" onPress={onConnectedRelay} /> };
});
// What a pane does with the computer it is given: reads it at once, and sends
// to it from the composer.
jest.mock("@/screens/pane", () => {
  const { useEffect } = require("react");
  const { Button } = require("react-native");
  const { useSession } = require("@/lib/session");
  return {
    Pane: ({ paneId }: { paneId: string }) => {
      const { api, activeComputerId } = useSession();
      useEffect(() => { void api.pane(paneId); }, [api, paneId]);
      return <Button title={`Send to ${paneId} on ${activeComputerId}`} onPress={() => void api.sendPrompt(paneId, "hello")} />;
    },
  };
});
jest.mock("@/lib/session", () => {
  const React = require("react");
  const Ctx = React.createContext(null);
  const panes = [{ paneId: "w1:p1" }, { paneId: "w1:p3" }];
  const apis: Record<string, object> = {};
  const apiFor = (id: string) => (apis[id] ??= {
    pane: async (paneId: string) => { mockCalls.push(`${id} read ${paneId}`); return { frame: null, layout: null }; },
    sendPrompt: async (paneId: string) => { mockCalls.push(`${id} send ${paneId}`); },
  });
  const computers = [
    { id: "A", name: "Alpha", serverId: "srv-a", kind: "relay", address: "relay · a", link: "live" },
    { id: "B", name: "Beta", serverId: "srv-b", kind: "relay", address: "relay · b", link: "live" },
  ];
  function SessionProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = React.useState({ active: "A", key: 0 });
    mockSession.switchComputer = async (id: string) => setState((s: { key: number }) => ({ active: id, key: s.key + 1 }));
    mockSession.signInRelay = () => { mockPairing = null; setState((s: { key: number }) => ({ active: "B", key: s.key + 1 })); };
    const value = {
      ready: true, connected: true, addingComputer: false, computers,
      activeComputerId: state.active, connectionKey: state.key,
      api: apiFor(state.active),
      session: { panes, workspaces: [], tabs: [], serverName: state.active === "A" ? "Alpha" : "Beta" },
      switchComputer: (id: string) => mockSession.switchComputer!(id),
      addComputer: async () => {},
      revokeComputer: async () => {},
      signInRelay: () => mockSession.signInRelay!(),
      signInSsh: () => {},
    };
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }
  return { SessionProvider, useSession: () => React.useContext(Ctx) };
});

import { Text, View } from "react-native";
import RootLayout from "../app/_layout";
import PaneRoute from "../app/pane/[paneId]";
import ComputersRoute from "../app/computers";
import ConnectRoute from "../app/connect";
import { ComputerSwitcher } from "@/components/computer-switcher";
import { openPane } from "@/lib/navigate";
import { useSession } from "@/lib/session";

/** Stands in for the tabs: the list a reset should leave alone on the stack. */
function Home() {
  const { activeComputerId } = useSession();
  return <View><ComputerSwitcher /><Text>{`Agents on ${activeComputerId}`}</Text></View>;
}

type Route = { name: string; params?: Record<string, unknown>; state?: { routes: Route[] } };
/** The root stack's routes, as `name` or `name paneId@computer`. */
function stack(view: ReturnType<typeof renderRouter>): string[] {
  const root = (view.getRouterState() as unknown as { routes: Route[] }).routes[0]!.state!.routes;
  return root.map(r => r.params?.paneId ? `${r.name} ${r.params.paneId}@${r.params.computer}` : r.name);
}

/** Promises, then the timers they started: `renderRouter` runs on fake timers. */
async function settle() {
  for (let round = 0; round < 3; round++) {
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    act(() => { jest.runOnlyPendingTimers(); });
  }
}

function launch() {
  const view = renderRouter({
    _layout: RootLayout,
    "(tabs)/_layout": () => <Slot />,
    "(tabs)/index": Home,
    "pane/[paneId]": PaneRoute,
    "space/[workspaceId]": () => null,
    computers: ComputersRoute,
    connect: ConnectRoute,
    "new-space": () => null,
    "new-agent": () => null,
  }, { initialUrl: "/" });
  return view;
}

beforeEach(() => {
  mockCalls.length = 0;
  mockPairing = null;
  jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((fn: FrameRequestCallback) => { fn(0); return 0; });
});
afterEach(() => jest.restoreAllMocks());

test("after a notification switches computers, Back never shows the old computer's pane of the same id", async () => {
  const view = launch();
  await settle();
  act(() => openPane("w1:p3", "A"));
  await settle();
  expect(screen.getByText("Send to w1:p3 on A")).toBeTruthy();

  await act(async () => { mockTap!("w1:p1", "srv-b"); });
  await settle();
  expect(stack(view)).toEqual(["(tabs)", "pane/[paneId] w1:p1@B"]);

  act(() => router.back());
  await settle();
  expect(stack(view)).toEqual(["(tabs)"]);
  expect(screen.getByText("Agents on B")).toBeTruthy();
  expect(screen.queryByText(/Send to w1:p3/, { includeHiddenElements: true })).toBeNull();
  // Computer B was asked only about the pane its notification named.
  expect(mockCalls.filter(call => call.startsWith("B"))).toEqual(["B read w1:p1"]);
});

test("switching from the Computers screen leaves only the new computer's list, and nothing is sent to it", async () => {
  const view = launch();
  await settle();
  act(() => openPane("w1:p3", "A"));
  await settle();
  act(() => router.push("/computers"));
  await settle();
  fireEvent.press(screen.getByTestId("computer-B"));
  await settle();
  expect(stack(view)).toEqual(["(tabs)"]);
  expect(screen.queryByText(/Send to/)).toBeNull();
  expect(mockCalls.filter(call => call.startsWith("B"))).toEqual([]);
});

test("confirming a pairing link over another computer's pane leaves only the new computer's list", async () => {
  const view = launch();
  await settle();
  act(() => openPane("w1:p3", "A"));
  await settle();
  mockPairing = { relay: "https://relay.example", server: "srv-b" };
  act(() => router.push("/connect"));
  await settle();
  fireEvent.press(screen.getByText("Pair Beta"));
  await settle();
  expect(stack(view)).toEqual(["(tabs)"]);
  expect(screen.getByText("Agents on B")).toBeTruthy();
  expect(mockCalls.filter(call => call.startsWith("B"))).toEqual([]);
});

test("a pane left on the stack by any other change of computer renders nothing there and takes itself off", async () => {
  const view = launch();
  await settle();
  act(() => openPane("w1:p3", "A"));
  await settle();
  // No reset at all: the pane route itself must refuse the new computer.
  await act(async () => { await mockSession.switchComputer!("B"); });
  await settle();
  expect(screen.queryByText("Send to w1:p3 on B")).toBeNull();
  expect(stack(view)).toEqual(["(tabs)"]);
  expect(mockCalls.filter(call => call.startsWith("B"))).toEqual([]);
});

test("a pane opened by a link without a computer is held to the computer it opened on", async () => {
  const view = launch();
  await settle();
  act(() => router.push("/pane/w1%3Ap3"));
  await settle();
  expect(stack(view)).toEqual(["(tabs)", "pane/[paneId] w1:p3@A"]);
  await act(async () => { await mockSession.switchComputer!("B"); });
  await settle();
  expect(stack(view)).toEqual(["(tabs)"]);
  expect(mockCalls.filter(call => call.startsWith("B"))).toEqual([]);
});
