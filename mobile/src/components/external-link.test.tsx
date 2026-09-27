import { act, fireEvent, render } from "@testing-library/react-native";
import { AccessibilityInfo, Alert, Linking, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { CopyOnHold } from "./copy";
import { ExternalLink } from "./external-link";

jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("@/lib/feel", () => ({ committed: jest.fn() }));

describe("ExternalLink", () => {
  const url = "https://example.com/docs?q=a%20b#one";
  let open: jest.SpyInstance;
  let alert: jest.SpyInstance;
  let announce: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (Clipboard.setStringAsync as jest.Mock).mockReset().mockResolvedValue(true);
    open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  test("tap opens the exact target while surrounding prose stays selectable", async () => {
    const view = render(<Text selectable>Read <ExternalLink url={url}>the docs</ExternalLink> now.</Text>);
    const link = view.getByRole("link", { name: "the docs" });
    const stopPropagation = jest.fn();
    await act(async () => { fireEvent.press(link, { stopPropagation }); });
    expect(open).toHaveBeenCalledWith(url);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(view.getByText("Read the docs now.").props.selectable).toBe(true);
  });

  test("holding a nested link copies only the URL, acknowledges it and suppresses the release tap", async () => {
    const view = render(<CopyOnHold text="whole region"><Text><ExternalLink url={url}>the docs</ExternalLink></Text></CopyOnHold>);
    const link = view.getByRole("link", { name: "the docs" });
    const stopPropagation = jest.fn();
    fireEvent(link, "pressIn");
    await act(async () => { fireEvent(link, "longPress", { stopPropagation }); });
    fireEvent.press(link, { stopPropagation });
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(url);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    expect(view.getByText(/· Copied/, { includeHiddenElements: true })).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("Link copied");
    act(() => jest.advanceTimersByTime(1500));
    expect(view.queryByText(/· Copied/, { includeHiddenElements: true })).toBeNull();
    fireEvent(link, "pressIn");
    await act(async () => { fireEvent.press(link); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("accessibility actions offer separate open and copy actions", async () => {
    const view = render(<ExternalLink url={url} />);
    const link = view.getByRole("link");
    expect(link.props.accessibilityActions).toEqual([{ name: "activate", label: "Open link" }, { name: "copy", label: "Copy link" }]);
    await act(async () => { fireEvent(link, "accessibilityAction", { nativeEvent: { actionName: "copy" }, stopPropagation: jest.fn() }); });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(url);
    expect(open).not.toHaveBeenCalled();
    await act(async () => { fireEvent(link, "accessibilityAction", { nativeEvent: { actionName: "activate" }, stopPropagation: jest.fn() }); });
    expect(open).toHaveBeenCalledWith(url);
  });

  test("opening failure is caught and offers a copy fallback", async () => {
    open.mockRejectedValueOnce(new Error("no application"));
    const view = render(<ExternalLink url={url} />);
    await act(async () => { fireEvent.press(view.getByRole("link")); });
    expect(alert).toHaveBeenCalledWith("Couldn’t open link", expect.stringContaining("copy"));
  });

  test.each([false, new Error("clipboard denied")])("copy failure never announces success: %s", async (failure) => {
    if (failure instanceof Error) (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(failure);
    else (Clipboard.setStringAsync as jest.Mock).mockResolvedValueOnce(failure);
    const view = render(<ExternalLink url={url} />);
    await act(async () => { fireEvent(view.getByRole("link"), "longPress"); });
    expect(alert).toHaveBeenCalledWith("Couldn’t copy link", expect.any(String));
    expect(announce).not.toHaveBeenCalled();
    expect(view.queryByText(/· Copied/, { includeHiddenElements: true })).toBeNull();
  });

  test.each(["javascript:alert(1)", "file:///tmp/report", "https:///example.com", "https://user:secret@example.com"])("rejects unsafe or malformed destination %s", async destination => {
    const view = render(<ExternalLink url={destination}>Unavailable target</ExternalLink>);
    expect(view.queryByRole("link")).toBeNull();
    await act(async () => { fireEvent.press(view.getByText("Unavailable target")); });
    expect(open).not.toHaveBeenCalled();
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });

  test("does not show stale feedback after an asynchronous copy unmounts", async () => {
    let finish!: (copied: boolean) => void;
    (Clipboard.setStringAsync as jest.Mock).mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const view = render(<ExternalLink url={url} />);
    fireEvent(view.getByRole("link"), "longPress");
    view.unmount();
    await act(async () => { finish(true); });
    expect(announce).not.toHaveBeenCalled();
  });

  test("a streamed URL change cannot inherit another target’s copy success", async () => {
    let finish!: (copied: boolean) => void;
    (Clipboard.setStringAsync as jest.Mock).mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const view = render(<ExternalLink url={url} />);
    fireEvent(view.getByRole("link"), "longPress");
    view.rerender(<ExternalLink url="https://other.example/" />);
    await act(async () => { finish(true); });
    expect(announce).not.toHaveBeenCalled();
    expect(view.queryByText(/· Copied/, { includeHiddenElements: true })).toBeNull();
  });
});
