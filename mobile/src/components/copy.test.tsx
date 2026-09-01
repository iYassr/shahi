import { act, fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { CopyOnHold } from "./copy";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));

/**
 * The hold-to-copy that monospace regions get instead of text selection —
 * inside a horizontal scroller the selection drag is already taken by panning.
 * The contract: a long press takes the *whole* text (including what is
 * scrolled out of view), says "Copied" for a moment, and stops saying it.
 */
describe("CopyOnHold", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (Clipboard.setStringAsync as jest.Mock).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  const draw = () =>
    render(
      <CopyOnHold text={"line one\nline two, off screen"}>
        <Text>line one</Text>
      </CopyOnHold>,
    );

  test("a long press copies the full text, not just what is visible", () => {
    const view = draw();
    fireEvent(view.getByText("line one"), "longPress");
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("line one\nline two, off screen");
  });

  test("says Copied for a moment, then stops", () => {
    const view = draw();
    expect(view.queryByText("Copied")).toBeNull();
    fireEvent(view.getByText("line one"), "longPress");
    expect(view.getByText("Copied")).toBeTruthy();

    act(() => jest.advanceTimersByTime(1500));
    expect(view.queryByText("Copied")).toBeNull();
  });

  // Two holds in a row: the second must restart the clock, or the badge
  // vanishes almost immediately after the second copy and reads as a failure.
  test("a second hold restarts the moment", () => {
    const view = draw();
    fireEvent(view.getByText("line one"), "longPress");
    act(() => jest.advanceTimersByTime(1000));
    fireEvent(view.getByText("line one"), "longPress");
    act(() => jest.advanceTimersByTime(1000));
    expect(view.getByText("Copied")).toBeTruthy();
    act(() => jest.advanceTimersByTime(500));
    expect(view.queryByText("Copied")).toBeNull();
  });
});
