import { fireEvent, render, screen } from "@testing-library/react-native";
import { Scanner } from "./scanner";

let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [mockPermission, jest.fn()] }));

// Build 32: with camera access refused this screen offered Open Settings and
// Cancel, and nothing else would pair the phone.
test("a refused camera still leaves a way to pair, by pasting the link", () => {
  mockPermission = { granted: false, canAskAgain: false };
  const onPaste = jest.fn();
  render(<Scanner onScanned={() => true} onCancel={jest.fn()} onPaste={onPaste} />);
  expect(screen.getByText("Shahi needs the camera to scan the code.")).toBeTruthy();
  expect(screen.getByTestId("open-settings")).toBeTruthy();
  fireEvent.press(screen.getByTestId("scanner-paste"));
  expect(onPaste).toHaveBeenCalledTimes(1);
});

// The owner, October 2026: a QR the camera cannot read left only Cancel on
// this screen, though the computer had copied the same code to its clipboard.
test("a code the camera cannot read can be pasted from the scanning screen", () => {
  mockPermission = { granted: true, canAskAgain: true };
  const onPaste = jest.fn();
  render(<Scanner onScanned={() => true} onCancel={jest.fn()} onPaste={onPaste} />);
  expect(screen.getByText("Point at the code your computer printed.")).toBeTruthy();
  fireEvent.press(screen.getByText("Can't scan? Paste pairing link"));
  expect(onPaste).toHaveBeenCalledTimes(1);
});
