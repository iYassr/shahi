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
