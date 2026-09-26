import { fireEvent, render, screen } from "@testing-library/react-native";
import { ComputerUpdate } from "./computer-update";
import type { ControlHandshake } from "@shahi/shared";
const mockRequest = jest.fn();
let mockControl: { handshake: ControlHandshake; pending: boolean; error: string | null; request: typeof mockRequest };
let mockServer = "relay://relay.getshahi.dev";
jest.mock("@/lib/session", () => ({ useSession: () => ({ control: mockControl, server: mockServer }) }));
beforeEach(() => {
  mockRequest.mockClear(); mockServer = "relay://relay.getshahi.dev";
  mockControl = { pending: false, error: null, request: mockRequest, handshake: {
    control: 1, serverId: "computer-a", api: { min: 5, max: 5 }, capabilities: ["computer-updates"],
    backend: { state: "connected", version: "0.9.0", protocol: 22 },
    update: { managed: true, channel: "stable", phase: "available", current: "0.3.0", available: "0.3.1" },
  } };
});
test("offers the selected computer's update and prevents duplicate requests during restart", () => {
  const result = render(<ComputerUpdate />);
  fireEvent.press(screen.getByText("Update computer")); expect(mockRequest).toHaveBeenCalledWith("install");
  mockControl.handshake.update.phase = "restarting"; result.rerender(<ComputerUpdate />);
  expect(screen.getByText("Restarting Shahi · reconnecting automatically…")).toBeTruthy();
  fireEvent.press(screen.getByText("Update computer")); expect(mockRequest).toHaveBeenCalledTimes(1);
});
test("recovery controls remain visible while herdr needs an adapter update", () => {
  mockControl.handshake.backend = { state: "service-update-required", message: "Update Shahi on this computer." };
  render(<ComputerUpdate />);
  expect(screen.getByText("Update required")).toBeTruthy();
  fireEvent.press(screen.getByText("Update computer")); expect(mockRequest).toHaveBeenCalledWith("install");
});
test("channel selection checks compatibility without automatically installing beta", () => {
  render(<ComputerUpdate settings />);
  fireEvent.press(screen.getByText("Beta")); expect(mockRequest).toHaveBeenCalledWith("check", "beta");
});

// A development checkout's notice sat on the Agents list, where it could not
// be dismissed; older servers still send it as a message (compatibility bug
// hunt). Settings is where it belongs.
test("an unmanaged computer shows no card on the Agents list, and its notice in Settings", () => {
  mockControl.handshake.update = { managed: false, channel: "stable", phase: "idle", current: "development", message: "Install the managed Shahi service on this computer to enable app updates." };
  const agents = render(<ComputerUpdate />);
  expect(screen.queryByTestId("computer-update")).toBeNull();
  agents.unmount();
  render(<ComputerUpdate settings />);
  expect(screen.getByTestId("computer-update")).toBeTruthy();
  expect(screen.queryByText("Check for updates")).toBeNull();
});

// An SSH computer was never paired; what it keeps is its saved login.
test("an unreachable SSH computer is not said to keep a pairing", () => {
  mockControl.error = "The SSH connection to box.example has closed. Try again.";
  mockServer = "ssh://me@box.example";
  const result = render(<ComputerUpdate />);
  expect(screen.getByText("Computer unavailable. Your SSH login is saved.")).toBeTruthy();
  expect(screen.queryByText(/pairing/)).toBeNull();
  mockServer = "relay://relay.getshahi.dev"; result.rerender(<ComputerUpdate />);
  expect(screen.getByText("Computer unavailable. Your pairing is saved.")).toBeTruthy();
});
