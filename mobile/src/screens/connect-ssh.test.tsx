/**
 * Adding a computer over SSH.
 *
 * The screen, `lib/tunnel` and the Keychain helper are real; only the native
 * SSH module (modelled on SshTunnelModule.swift, which replaces a forward
 * already open under the same id) and the two sidecar calls are faked. The
 * pre-release review found a failed re-add closing a saved computer's tunnel.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
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
jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return { ...actual, api: { ...actual.api, meta: jest.fn(async () => ({ serverId: "box", api: { min: 5, max: 5 } })), login: () => mockLogin() } };
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
const pins = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks(); pins.clear(); mockForwards.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => pins.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => { pins.set(key, value); });
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

test("a failed re-add of a saved SSH computer leaves that computer's own tunnel running", async () => {
  pins.set("shahi.knownhost.box.example_22", "bmV3LWtleS1zaGEyNTY=");
  const profile: SshProfile = { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "old", auth: { kind: "password", password: "old" } };
  const saved = await openTunnel(profile);
  mockLogin.mockRejectedValueOnce(new Error("That passcode did not work."));

  fillSshForm();

  expect(await screen.findByText("That passcode did not work.")).toBeTruthy();
  expect([...mockForwards.values()]).toEqual([Number(saved.split(":").at(-1))]);
});
