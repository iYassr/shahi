import { act, fireEvent, render } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { VoiceInput } from "./voice-input";
import { voice, type VoiceEvent, type VoiceSupport } from "@/lib/voice";

jest.mock("expo-router", () => ({ useFocusEffect: (effect: () => void) => require("react").useEffect(effect, [effect]) }));
jest.mock("@/lib/voice", () => ({ voice: {
  support: jest.fn(), prepare: jest.fn(), start: jest.fn(), stop: jest.fn(), cancel: jest.fn(), progress: jest.fn(), listen: jest.fn(),
} }));
const native = voice as jest.Mocked<typeof voice>;
const supported: VoiceSupport = { available: true, preferred: "en-US", maximumSeconds: 300,
  locales: [{ id: "en-US", name: "English", installed: true }, { id: "ar-SA", name: "Arabic", installed: false }] };
let event: (event: VoiceEvent) => void;
let background: (state: AppStateStatus) => void;
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  native.support.mockResolvedValue(supported);
  native.prepare.mockResolvedValue(true); native.start.mockResolvedValue();
  native.stop.mockResolvedValue("Update the README."); native.cancel.mockResolvedValue(); native.progress.mockResolvedValue(0);
  native.listen.mockImplementation(cb => { event = cb; return { remove: jest.fn() }; });
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, cb) => { background = cb; return { remove: jest.fn() }; });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

async function open() {
  const onUse = jest.fn(), onClose = jest.fn();
  const view = render(<VoiceInput onUse={onUse} onClose={onClose} />);
  await settle();
  return { ...view, onUse, onClose };
}
async function recording() {
  const view = await open();
  fireEvent.press(view.getByText("Record")); await settle();
  expect(native.start).toHaveBeenCalledTimes(1);
  return view;
}

test("opening the sheet never requests the microphone; stopped speech is editable and used only on an explicit tap", async () => {
  const view = await open();
  expect(native.prepare).not.toHaveBeenCalled(); expect(native.start).not.toHaveBeenCalled();
  fireEvent.press(view.getByText("Record")); await settle();
  const id = native.prepare.mock.calls[0][0];
  expect(native.prepare).toHaveBeenCalledWith(id, "en-US", false);
  fireEvent.press(view.getByText("Stop and transcribe")); await settle();
  expect(view.getByLabelText("Edit voice transcript").props.value).toBe("Update the README.");
  expect(view.onUse).not.toHaveBeenCalled();
  fireEvent.changeText(view.getByLabelText("Edit voice transcript"), "  Update CLAUDE.md.  ");
  const add = view.getByText("Add to reply");
  fireEvent.press(add); fireEvent.press(add);
  expect(view.onUse).toHaveBeenCalledTimes(1); expect(view.onUse).toHaveBeenCalledWith("Update CLAUDE.md.");
  expect(view.onClose).toHaveBeenCalledTimes(1);
});

test("a language download never starts recording, and reselecting the downloaded language preserves readiness", async () => {
  const view = await open();
  fireEvent.press(view.getByLabelText("Choose transcription language"));
  fireEvent.press(view.getByText("Arabic · download needed"));
  fireEvent.press(view.getByText("Download language")); await settle();
  expect(native.prepare).toHaveBeenCalledWith(expect.any(String), "ar-SA", true);
  expect(native.start).not.toHaveBeenCalled();
  fireEvent.press(view.getByLabelText("Choose transcription language"));
  fireEvent.press(view.getByText("Arabic"));
  fireEvent.press(view.getByText("Record")); await settle();
  expect(native.prepare).toHaveBeenLastCalledWith(expect.any(String), "ar-SA", false);
  expect(native.start).toHaveBeenCalledTimes(1);
});

test("a model removed by iOS offers an explicit download instead of silently fetching or getting stuck", async () => {
  native.prepare.mockResolvedValueOnce(false);
  const view = await open();
  fireEvent.press(view.getByText("Record")); await settle();
  expect(view.getByText("Download language")).toBeTruthy();
  expect(native.start).not.toHaveBeenCalled();
});

test("cancelling a pending preparation cannot open the microphone after it completes", async () => {
  const pending = deferred<boolean>(); native.prepare.mockReturnValueOnce(pending.promise);
  const view = await open(); fireEvent.press(view.getByText("Record")); await settle();
  const id = native.prepare.mock.calls[0][0];
  fireEvent.press(view.getByLabelText("Cancel voice input"));
  await act(async () => pending.resolve(true));
  expect(native.cancel).toHaveBeenCalledWith(id); expect(native.start).not.toHaveBeenCalled();
  expect(view.onUse).not.toHaveBeenCalled();
});

test("closing during the microphone permission prompt cancels again when permission returns", async () => {
  const pending = deferred<void>(); native.start.mockReturnValueOnce(pending.promise);
  const view = await open(); fireEvent.press(view.getByText("Record")); await settle();
  const id = native.start.mock.calls[0][0];
  view.unmount(); await act(async () => pending.resolve());
  expect(native.cancel).toHaveBeenLastCalledWith(id); expect(native.stop).not.toHaveBeenCalled();
});

test("a transcript that finishes after leaving the conversation is discarded", async () => {
  const pending = deferred<string>(); native.stop.mockReturnValueOnce(pending.promise);
  const view = await recording();
  fireEvent.press(view.getByText("Stop and transcribe")); await settle();
  view.unmount(); await act(async () => pending.resolve("Belongs to the previous conversation"));
  expect(view.onUse).not.toHaveBeenCalled(); expect(native.cancel).toHaveBeenCalledWith(native.start.mock.calls[0][0]);
});

test("an interruption ends only its recording, and old native events cannot end a later recording", async () => {
  const view = await recording(); const oldID = native.start.mock.calls[0][0];
  act(() => event({ id: oldID, kind: "interrupted" }));
  expect(view.getByText("Recording was interrupted. Please start again.")).toBeTruthy();
  fireEvent.press(view.getByText("Record")); await settle();
  const newID = native.start.mock.calls[1][0]; expect(newID).not.toBe(oldID);
  act(() => event({ id: oldID, kind: "limit" }));
  expect(native.stop).not.toHaveBeenCalled();
  act(() => event({ id: newID, kind: "limit" })); await settle();
  expect(native.stop).toHaveBeenCalledWith(newID);
});

test("permission dialogs do not cancel voice input, but backgrounding the app does", async () => {
  const view = await recording();
  act(() => background("inactive")); expect(view.onClose).not.toHaveBeenCalled();
  act(() => background("background"));
  expect(view.onClose).toHaveBeenCalledTimes(1); expect(native.cancel).toHaveBeenCalledWith(native.start.mock.calls[0][0]);
});

test("the duration cap and a repeated Stop cannot launch duplicate transcriptions", async () => {
  const pending = deferred<string>(); native.stop.mockReturnValueOnce(pending.promise);
  const view = await recording(); const stop = view.getByText("Stop and transcribe");
  act(() => jest.advanceTimersByTime(300_000));
  fireEvent.press(stop); act(() => event({ id: native.start.mock.calls[0][0], kind: "limit" }));
  expect(native.stop).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve("Completed"));
});

test("a hung transcription can be retried and its late result cannot replace the next attempt", async () => {
  const pending = deferred<string>(); native.stop.mockReturnValueOnce(pending.promise);
  const view = await recording(); fireEvent.press(view.getByText("Stop and transcribe")); await settle();
  act(() => jest.advanceTimersByTime(121_000));
  expect(view.getByText("Transcription took too long. Please try a shorter recording.")).toBeTruthy();
  fireEvent.press(view.getByText("Record")); await settle();
  await act(async () => pending.resolve("Stale result"));
  expect(view.queryByLabelText("Edit voice transcript")).toBeNull();
  expect(view.getByText("Stop and transcribe")).toBeTruthy();
});

test("microphone denial keeps a readable explanation and a route to Settings", async () => {
  native.start.mockRejectedValueOnce(new Error("Microphone access is off. Enable it for Shahi in Settings to record a prompt."));
  const view = await open(); fireEvent.press(view.getByText("Record")); await settle();
  expect(view.getByText("Open Settings")).toBeTruthy(); expect(native.cancel).toHaveBeenCalled();
});

test("unsupported hardware offers an explanation and cannot record", async () => {
  native.support.mockResolvedValueOnce({ ...supported, available: false, locales: [] });
  const view = await open();
  expect(view.getByText(/requires iOS 26/)).toBeTruthy(); expect(view.queryByText("Record")).toBeNull();
});

test("an older binary without the module offers an update instead of crashing", async () => {
  native.support.mockImplementationOnce(() => { throw new Error("Update Shahi to use on-device voice input."); });
  const view = await open(); expect(view.getByText("Update Shahi to use on-device voice input.")).toBeTruthy();
});

test("an unavailable preferred language requires a choice instead of guessing the recording language", async () => {
  native.support.mockResolvedValueOnce({ ...supported, preferred: "" });
  const view = await open(); fireEvent.press(view.getByText("Record")); await settle();
  expect(native.prepare).not.toHaveBeenCalled(); expect(view.getByText(/Choose a language/)).toBeTruthy();
});
