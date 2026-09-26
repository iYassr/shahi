/**
 * Adding a computer over SSH: what the person sees before their login leaves
 * the phone.
 *
 * The screen, `lib/tunnel` and the Keychain helper are real; only the native
 * SSH module (modelled on SshTunnelModule.swift, which replaces a forward
 * already open under the same id) and the two sidecar calls are faked. The
 * pre-release review found the first host key trusted without a word, a
 * changed key a dead end, and a failed re-add closing a saved computer's
 * tunnel.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import type { SshProfile } from "@/lib/ssh";

// Built inside the factory: `lib/tunnel` asks for the module while the
// imports below load, before this file's own constants exist.
jest.mock("expo", () => {
  const forwards = new Map<string, number>();
  let port = 50000;
  const sshTunnel = {
    forwards,
    hostKey: jest.fn(async () => ({ hostKey: "bmV3LWtleS1zaGEyNTY=", keyType: "ED25519" })),
    open: jest.fn(async ({ id }: { id: string }) => { forwards.delete(id); forwards.set(id, ++port); return { localPort: port }; }),
    close: jest.fn(async (id: string) => { forwards.delete(id); }),
  };
  return {
    ...jest.requireActual("expo"),
    requireOptionalNativeModule: (name: string) => (name === "SshTunnel" ? sshTunnel : null),
  };
});
const mockLogin = jest.fn(async () => "shahi_session=fake");
const mockMeta = jest.fn(async (_connection: unknown): Promise<unknown> => ({ serverId: "box", api: { min: 5, max: 5 } }));
jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  // Connect signs in on a client of its own, so that is the one answered.
  return { ...actual, createApi: (connection: { cookie: string | null }) => ({
    ...actual.createApi(connection), meta: () => mockMeta(connection),
    login: async () => { connection.cookie = await mockLogin(); return connection.cookie; },
  }) };
});
jest.mock("@/components/scanner", () => ({ Scanner: () => null }));
jest.mock("@/components/icons", () => ({ Logo: () => null, Wordmark: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-device", () => ({ deviceName: null, modelName: "iPhone" }));

import { requireOptionalNativeModule } from "expo";
import { Connect } from "./connect";
import { openTunnel } from "@/lib/tunnel";

const mockNative = requireOptionalNativeModule("SshTunnel") as unknown as {
  forwards: Map<string, number>; hostKey: jest.Mock; open: jest.Mock; close: jest.Mock;
};
const mockForwards = mockNative.forwards;
/** This build's own keychain service, and the default one builds up to TestFlight 15 wrote. */
const pins = new Map<string, string>();
const earlierPins = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks(); pins.clear(); earlierPins.clear(); mockForwards.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string, options?: object) => (options ? pins : earlierPins).get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string, options?: object) => { (options ? pins : earlierPins).set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string, options?: object) => { (options ? pins : earlierPins).delete(key); });
});

function fillSshForm() {
  const onConnectedSsh = jest.fn();
  render(<Connect onConnectedSsh={onConnectedSsh} onConnectedRelay={jest.fn()} />);
  fireEvent.press(screen.getByTestId("use-ssh"));
  fireEvent.changeText(screen.getByTestId("ssh-host"), "box.example");
  fireEvent.changeText(screen.getByTestId("ssh-username"), "me");
  fireEvent.changeText(screen.getByTestId("ssh-password"), "the-password");
  fireEvent.changeText(screen.getByTestId("ssh-passcode"), "2468");
  fireEvent.press(screen.getByTestId("connect"));
  return onConnectedSsh;
}

test("a first SSH connection shows the server's fingerprint before the login, and Cancel sends nothing", async () => {
  fillSshForm();

  expect(await screen.findByText("Check this computer’s identity")).toBeTruthy();
  expect(screen.getByTestId("host-key-fingerprint").props.children).toBe("SHA256:bmV3LWtleS1zaGEyNTY");
  expect(screen.getByText("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")).toBeTruthy();
  expect(mockNative.open).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId("reject-host-key"));
  expect(await screen.findByText("Not connected. Nothing was sent to that computer.")).toBeTruthy();
  expect(mockNative.open).not.toHaveBeenCalled();
  expect(mockLogin).not.toHaveBeenCalled();
  expect(pins.size).toBe(0);
});

test("a changed host key shows both fingerprints and connects only after a deliberate re-trust", async () => {
  pins.set("shahi.knownhost.box.example_22", "b2xkLWtleS1zaGEyNTY=");
  const onConnectedSsh = fillSshForm();

  expect(await screen.findByText("This computer’s identity has changed")).toBeTruthy();
  expect(screen.getByTestId("host-key-previous").props.children).toBe("SHA256:b2xkLWtleS1zaGEyNTY");
  expect(screen.getByTestId("host-key-fingerprint").props.children).toBe("SHA256:bmV3LWtleS1zaGEyNTY");
  expect(mockNative.open).not.toHaveBeenCalled();

  fireEvent.press(screen.getByText("Trust the new key"));
  await waitFor(() => expect(onConnectedSsh).toHaveBeenCalledWith(
    expect.objectContaining<Partial<SshProfile>>({ host: "box.example" }),
    { baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), cookie: "shahi_session=fake", relay: null, via: "box.example" },
  ));
  expect(mockNative.open).toHaveBeenCalledWith(expect.objectContaining({ expectedHostKey: "bmV3LWtleS1zaGEyNTY=" }));
  expect(pins.get("shahi.knownhost.box.example_22")).toBe("bmV3LWtleS1zaGEyNTY=");
});

// Builds up to TestFlight 15 pinned the first key they met without showing
// it. This build carried such a pin over as reviewed, and Connect skipped the
// review because the key presented matched it (pre-release bug hunt).
test("a key an earlier version trusted unseen is shown before the login, even though it has not changed", async () => {
  earlierPins.set("shahi.knownhost.box.example_22", "bmV3LWtleS1zaGEyNTY=");
  const onConnectedSsh = fillSshForm();

  expect(await screen.findByText("Check this computer’s identity")).toBeTruthy();
  expect(screen.getByText(/An earlier version of Shahi trusted this key for box\.example without showing it to you/)).toBeTruthy();
  expect(screen.getByTestId("host-key-fingerprint").props.children).toBe("SHA256:bmV3LWtleS1zaGEyNTY");
  expect(screen.queryByTestId("host-key-previous")).toBeNull();
  expect(mockNative.open).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId("trust-host-key"));
  await waitFor(() => expect(onConnectedSsh).toHaveBeenCalled());
  expect(mockNative.open).toHaveBeenCalledWith(expect.objectContaining({ expectedHostKey: "bmV3LWtleS1zaGEyNTY=" }));
  // Reviewed now, so it is this build's own, and the unseen copy is gone.
  expect(pins.get("shahi.knownhost.box.example_22")).toBe("bmV3LWtleS1zaGEyNTY=");
  expect(earlierPins.size).toBe(0);
});

test("a failed re-add of a saved SSH computer leaves that computer's own tunnel running", async () => {
  pins.set("shahi.knownhost.box.example_22", "bmV3LWtleS1zaGEyNTY=");
  const profile: SshProfile = { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "old", auth: { kind: "password", password: "old" } };
  const saved = await openTunnel(profile);
  mockLogin.mockRejectedValueOnce(new Error("That passcode did not work."));

  fillSshForm();

  expect(await screen.findByText("That passcode did not work.")).toBeTruthy();
  expect([...mockForwards.values()]).toEqual([Number(saved.split(":").at(-1))]);
});

// A server with AllowTcpForwarding off accepted the login, and every request
// through the forward then failed as "The connection to 127.0.0.1:54119
// dropped mid-request" — a port on the phone, and not the cause.
test("an SSH server that will not forward a port says so, instead of naming the phone's own port", async () => {
  pins.set("shahi.knownhost.box.example_22", "bmV3LWtleS1zaGEyNTY=");
  mockNative.open.mockRejectedValueOnce(Object.assign(
    new Error("ssh_forwarding: Signed in to box.example, but its SSH server does not allow port forwarding, which Shahi needs. Allow it for this user (AllowTcpForwarding in sshd_config) and try again. (at ExpoModulesCore/Promise.swift:65)"),
    { code: "ssh_forwarding" },
  ));
  fillSshForm();
  expect(await screen.findByText(/^Signed in to box\.example, but its SSH server does not allow port forwarding/)).toBeTruthy();
  expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  expect(mockLogin).not.toHaveBeenCalled();
});

test("a forward that drops while signing in is described by the SSH host, not the phone's own port", async () => {
  pins.set("shahi.knownhost.box.example_22", "bmV3LWtleS1zaGEyNTY=");
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => { throw new TypeError("The network connection was lost."); });
  const { createApi: realApi } = jest.requireActual("@/lib/api");
  mockMeta.mockImplementationOnce(async (connection) => realApi(connection).meta());
  try {
    fillSshForm();
    expect(await screen.findByText("The SSH connection to box.example dropped mid-request. Try again.")).toBeTruthy();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
});
