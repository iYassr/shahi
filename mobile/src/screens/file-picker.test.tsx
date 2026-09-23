import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FilePicker } from "./pane";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
let mockApi = { dirs: jest.fn(), upload: jest.fn() };
jest.mock("@/lib/session", () => ({ useSession: () => ({ api: mockApi }) }));
jest.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
jest.mock("@/lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));
jest.mock("expo-image-picker", () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn(), UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" } }));
jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));
const folder = (name: string) => ({ name, path: `/${name}`, display: `/${name}`, isDirectory: true });
const file = (name: string) => ({ ...folder(name), isDirectory: false });
beforeEach(() => { jest.clearAllMocks(); mockApi = { dirs: jest.fn().mockResolvedValue({ entries: [], parent: null }), upload: jest.fn() }; });

test("switching computers reloads folders and ignores the old computer’s response", async () => {
  let resolveSlow!: (value: unknown) => void;
  mockApi.dirs.mockImplementation(() => new Promise(resolve => { resolveSlow = resolve; }));
  const props = { onPick: jest.fn(), onClose: jest.fn() };
  const view = render(<FilePicker {...props} />);
  mockApi = { dirs: jest.fn().mockResolvedValue({ entries: [file("current.txt")], parent: null }), upload: jest.fn() };
  view.rerender(<FilePicker {...props} />);
  await waitFor(() => view.getByText("current.txt"));
  await act(async () => resolveSlow({ entries: [file("stale.txt")], parent: "/" }));
  expect(view.queryByText("stale.txt")).toBeNull();
  expect(view.getByText("current.txt")).toBeTruthy();
});

test("opening a folder removes the previous folder’s tappable files while loading", async () => {
  mockApi.dirs.mockResolvedValueOnce({ entries: [folder("first"), file("old.txt")], parent: null })
    .mockImplementation(() => new Promise(() => {}));
  const view = render(<FilePicker onPick={jest.fn()} onClose={jest.fn()} />);
  await waitFor(() => view.getByText("first"));
  fireEvent.press(view.getByText("first"));
  expect(view.queryByText("old.txt")).toBeNull();
});

test("folder failure offers a retry instead of looking like an empty folder", async () => {
  mockApi.dirs.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ entries: [file("report.txt")], parent: null });
  const view = render(<FilePicker onPick={jest.fn()} onClose={jest.fn()} />);
  await waitFor(() => view.getByText("Try again"));
  fireEvent.press(view.getByText("Try again"));
  await waitFor(() => view.getByText("report.txt"));
  expect(view.queryByText("Try again")).toBeNull();
});

test("photo permission errors are shown without leaving the picker busy", async () => {
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockRejectedValue(new Error("Photos unavailable"));
  const view = render(<FilePicker onPick={jest.fn()} onClose={jest.fn()} />);
  fireEvent.press(view.getByText("Photo"));
  await waitFor(() => view.getByText("Photos unavailable"));
  expect(view.queryByText("Uploading…")).toBeNull();
  expect(mockApi.upload).not.toHaveBeenCalled();
});

test("closing while choosing a file prevents a later upload", async () => {
  let resolve!: (value: unknown) => void;
  (DocumentPicker.getDocumentAsync as jest.Mock).mockImplementation(() => new Promise(done => { resolve = done; }));
  const onPick = jest.fn();
  const view = render(<FilePicker onPick={onPick} onClose={jest.fn()} />);
  fireEvent.press(view.getByText("File on phone"));
  view.unmount();
  await act(async () => resolve({ canceled: false, assets: [{ uri: "file://test.txt", name: "test.txt" }] }));
  expect(mockApi.upload).not.toHaveBeenCalled();
  expect(onPick).not.toHaveBeenCalled();
});

// An upload that finished as Cancel was tapped used to attach itself anyway:
// over SSH nothing listened to Cancel, so the path landed in the composer the
// person had just said no to, ready to be sent (pre-release review).
test("a cancelled upload is never attached, even when it finishes anyway", async () => {
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  mockApi.upload.mockImplementation((_file: unknown, options: { signal?: AbortSignal }) => {
    signal = options.signal;
    return new Promise(done => { finish = done; });
  });
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: "file://big.mov", name: "big.mov", size: 20 * 1024 * 1024 }] });
  const onPick = jest.fn();
  const view = render(<FilePicker onPick={onPick} onClose={jest.fn()} />);
  fireEvent.press(view.getByText("File on phone"));
  await waitFor(() => view.getByText("Cancel upload"));
  // The picker's size travels with the file: it bounds an SSH upload's deadline.
  expect(mockApi.upload.mock.calls[0][0]).toMatchObject({ name: "big.mov", size: 20 * 1024 * 1024 });
  fireEvent.press(view.getByText("Cancel upload"));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ path: "/home/y/.shahi/uploads/big.mov", name: "big.mov", size: 1 }));
  expect(onPick).not.toHaveBeenCalled();
  expect(view.getByText("Upload cancelled.")).toBeTruthy();
  expect(view.queryByText("Cancel upload")).toBeNull();
});
