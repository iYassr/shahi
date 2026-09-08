import { fireEvent, render, screen } from "@testing-library/react-native";
import { ComputerUpdate } from "./computer-update";
import type { ControlHandshake } from "@shahi/shared";
const mockRequest = jest.fn();
let mockControl: { handshake: ControlHandshake; pending: boolean; error: string | null; request: typeof mockRequest };
jest.mock("@/lib/session", () => ({ useSession: () => ({ control: mockControl }) }));
beforeEach(() => {
  mockRequest.mockClear();
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
