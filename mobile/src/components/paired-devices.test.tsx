import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { PairedDevices, relative } from "./paired-devices";

jest.mock("@/lib/api", () => ({
  api: { devices: jest.fn(), revokeDevice: jest.fn() },
}));
const { api } = jest.requireMock("@/lib/api") as {
  api: { devices: jest.Mock; revokeDevice: jest.Mock };
};

/**
 * The Settings section that makes pairing worth having: you can see which
 * phones are in, and throw one out. What must hold — a revoke asks first, the
 * phone in your hand is called a sign-out, and passcode logins are said not to
 * be listed rather than left looking like nobody is signed in.
 */
describe("paired devices", () => {
  const now = Date.now();
  const mine = { id: "dev-me", name: "Yasser's iPhone", createdAt: now - 3 * 86_400_000, lastSeenAt: now };
  const other = { id: "dev-old", name: "Old iPad", createdAt: now - 30 * 86_400_000, lastSeenAt: now - 7_200_000 };

  beforeEach(() => {
    api.devices.mockReset();
    api.revokeDevice.mockReset();
    // The spy outlives one test; its call list must not.
    jest.spyOn(Alert, "alert").mockImplementation(() => {}).mockClear();
  });

  test("lists every phone, marks this one, and says passcode logins are not here", async () => {
    api.devices.mockResolvedValue({ devices: [other, mine], thisDeviceId: "dev-me" });
    const view = render(<PairedDevices onRevokedSelf={jest.fn()} />);
    await waitFor(() => view.getByText(/Old iPad/));
    expect(view.getByText(/Yasser's iPhone/)).toBeTruthy();
    expect(view.getByText(/this phone/)).toBeTruthy();
    expect(view.getByText(/seen 2h ago/)).toBeTruthy();
    expect(view.getByText(/Passcode sign-ins aren't devices/)).toBeTruthy();
    // The phone in hand is offered a sign-out, the other a revoke.
    expect(view.getByTestId("revoke-dev-me")).toHaveTextContent("Sign out");
    expect(view.getByTestId("revoke-dev-old")).toHaveTextContent("Revoke");
  });

  test("a passcode login is told it is one, with nothing to revoke", async () => {
    api.devices.mockResolvedValue({ devices: [], thisDeviceId: null });
    const view = render(<PairedDevices onRevokedSelf={jest.fn()} />);
    await waitFor(() => view.getByText(/This phone signed in with the passcode/));
    expect(view.getByText(/No phones have paired by code yet/)).toBeTruthy();
  });

  test("a restore-time routing race can be retried and a live transition retries automatically", async () => {
    api.devices
      .mockRejectedValueOnce(new Error("No server address configured"))
      .mockResolvedValue({ devices: [mine], thisDeviceId: "dev-me" });
    const view = render(<PairedDevices onRevokedSelf={jest.fn()} refreshKey="connecting" />);
    await waitFor(() => view.getByTestId("retry-devices"));

    view.rerender(<PairedDevices onRevokedSelf={jest.fn()} refreshKey="live" />);
    await waitFor(() => view.getByText(/Yasser's iPhone/));
    expect(api.devices).toHaveBeenCalledTimes(2);
  });

  // There is no undo: the server refuses the revoked phone's next request.
  test("revoking another phone asks first, then removes it", async () => {
    api.devices
      .mockResolvedValueOnce({ devices: [other, mine], thisDeviceId: "dev-me" })
      .mockResolvedValueOnce({ devices: [mine], thisDeviceId: "dev-me" });
    api.revokeDevice.mockResolvedValue({ ok: true });
    const onRevokedSelf = jest.fn();
    const view = render(<PairedDevices onRevokedSelf={onRevokedSelf} />);
    await waitFor(() => view.getByTestId("revoke-dev-old"));

    fireEvent.press(view.getByTestId("revoke-dev-old"));
    expect(api.revokeDevice).not.toHaveBeenCalled();
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0]!;
    expect(title).toBe("Revoke Old iPad?");
    await act(async () => buttons[1].onPress());

    expect(api.revokeDevice).toHaveBeenCalledWith("dev-old");
    await waitFor(() => expect(view.queryByText(/Old iPad/)).toBeNull());
    expect(onRevokedSelf).not.toHaveBeenCalled();
  });

  test("revoking this phone is a sign-out", async () => {
    api.devices.mockResolvedValue({ devices: [mine], thisDeviceId: "dev-me" });
    api.revokeDevice.mockResolvedValue({ ok: true });
    const onRevokedSelf = jest.fn();
    const view = render(<PairedDevices onRevokedSelf={onRevokedSelf} />);
    await waitFor(() => view.getByTestId("revoke-dev-me"));

    fireEvent.press(view.getByTestId("revoke-dev-me"));
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0]!;
    expect(title).toBe("Sign this phone out?");
    await act(async () => buttons[1].onPress());
    expect(api.revokeDevice).toHaveBeenCalledWith("dev-me");
    await waitFor(() => expect(onRevokedSelf).toHaveBeenCalled());
  });

  test("ages read the way a person would say them", () => {
    const t = 1_000_000_000;
    expect(relative(t - 5_000, t)).toBe("just now");
    expect(relative(t - 300_000, t)).toBe("5m ago");
    expect(relative(t - 3 * 3_600_000, t)).toBe("3h ago");
    expect(relative(t - 2 * 86_400_000, t)).toBe("2d ago");
  });
});
