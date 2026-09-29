import { useState } from "react";
import { View } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "@/components/text";
import type { DictationEvent } from "@/lib/dictation";
import { DictationButton, DictationPanel, useDictation } from "./dictation";

/**
 * The native module (mobile/modules/dictation) as the hook sees it: calls that
 * resolve when the test says, and events the test sends.
 */
const mockListeners = new Set<(event: DictationEvent) => void>();
const mockNative = {
  availability: jest.fn(async () => ({ available: true, installed: true })),
  install: jest.fn(async (_id: string) => {}),
  start: jest.fn(async (_id: string) => {}),
  finish: jest.fn(async (_id: string) => "Fix the flaky login test."),
  cancel: jest.fn(async (_id: string) => {}),
};
jest.mock("@/lib/dictation", () => ({
  ...jest.requireActual("@/lib/dictation"),
  dictation: {
    availability: () => mockNative.availability(),
    install: (id: string) => mockNative.install(id),
    start: (id: string) => mockNative.start(id),
    finish: (id: string) => mockNative.finish(id),
    cancel: (id: string) => mockNative.cancel(id),
    listen: (listener: (event: DictationEvent) => void) => {
      mockListeners.add(listener);
      return { remove: () => { mockListeners.delete(listener); } };
    },
  },
}));
const { appendDictation } = jest.requireActual("@/lib/dictation") as typeof import("@/lib/dictation");

/** Omit over each member of the union; plain Omit keeps only the shared fields. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
function emit(event: WithoutId<DictationEvent>) {
  const id = mockNative.start.mock.calls.at(-1)?.[0] ?? mockNative.install.mock.calls.at(-1)?.[0];
  act(() => { for (const listener of [...mockListeners]) listener({ ...event, id } as DictationEvent); });
}

/** A reply box the way the pane has one: a draft that outlives the screen. */
const store = { text: "" };
function Composer() {
  const [draft, setDraft] = useState(store.text);
  const voice = useDictation((text) => { store.text = appendDictation(store.text, text); setDraft(store.text); });
  return (
    <View>
      <DictationPanel voice={voice} />
      {voice.available && <DictationButton voice={voice} disabled={false} />}
      <Text testID="draft">{draft}</Text>
    </View>
  );
}

async function listening() {
  const view = render(<Composer />);
  const mic = await view.findByLabelText("Dictate");
  await act(async () => { fireEvent.press(mic); });
  await view.findByText(/Listening/);
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  store.text = "Please";
  mockNative.availability.mockImplementation(async () => ({ available: true, installed: true }));
  mockNative.finish.mockImplementation(async () => "Fix the flaky login test.");
});

test("an iPhone that cannot run Apple's model shows no microphone, so there is no weaker engine to fall back to", async () => {
  mockNative.availability.mockImplementation(async () => ({ available: false, installed: false }));
  const view = render(<Composer />);
  await waitFor(() => expect(view.queryByLabelText("Dictate")).toBeNull());
  expect(mockNative.start).not.toHaveBeenCalled();
});

test("words appear while speaking, tentative ones dimmed, and Add puts the settled text in the reply without sending", async () => {
  const view = await listening();
  emit({ kind: "text", finalized: "Fix the flaky", volatile: "log in" });
  expect(view.getByText(/Fix the flaky/)).toBeTruthy();
  expect(view.getByText("log in")).toBeTruthy();
  emit({ kind: "level", level: 0.6 });
  expect(view.getByLabelText("Microphone level").props.accessibilityValue.now).toBe(60);
  await act(async () => { fireEvent.press(view.getByLabelText("Add to reply")); });
  expect(mockNative.finish).toHaveBeenCalledTimes(1);
  expect(view.getByTestId("draft").props.children).toBe("Please Fix the flaky login test.");
  expect(view.queryByText(/Listening/)).toBeNull();
});

test("tapping the microphone again also adds what was said", async () => {
  const view = await listening();
  await act(async () => { fireEvent.press(view.getByLabelText("Stop dictating and add to reply")); });
  expect(view.getByTestId("draft").props.children).toBe("Please Fix the flaky login test.");
});

test("Cancel throws the dictation away and leaves the draft alone", async () => {
  const view = await listening();
  emit({ kind: "text", finalized: "Delete everything", volatile: "" });
  await act(async () => { fireEvent.press(view.getByLabelText("Cancel dictation")); });
  expect(mockNative.cancel).toHaveBeenCalledTimes(1);
  expect(mockNative.finish).not.toHaveBeenCalled();
  expect(view.getByTestId("draft").props.children).toBe("Please");
});

test("a call or a lost headset stops dictation but keeps what was said", async () => {
  const view = await listening();
  emit({ kind: "stopped", reason: "interrupted", text: "Check the logs first." });
  expect(view.getByTestId("draft").props.children).toBe("Please Check the logs first.");
  expect(view.getByText("Dictation stopped. What you said is in your reply.")).toBeTruthy();
});

test("leaving the conversation mid-sentence keeps what was said in its draft", async () => {
  const view = await listening();
  emit({ kind: "text", finalized: "Run the migration", volatile: "and" });
  await act(async () => { view.unmount(); });
  expect(mockNative.finish).toHaveBeenCalledTimes(1);
  expect(store.text).toBe("Please Fix the flaky login test.");
});

test("if the last words fail, the ones already settled on screen are kept", async () => {
  mockNative.finish.mockImplementation(async () => { throw new Error("What you said could not be transcribed. Please try again."); });
  const view = await listening();
  emit({ kind: "text", finalized: "Open the settings screen", volatile: "and" });
  await act(async () => { fireEvent.press(view.getByLabelText("Add to reply")); });
  expect(view.getByTestId("draft").props.children).toBe("Please Open the settings screen");
  expect(view.getByText("What you said could not be transcribed. Please try again.")).toBeTruthy();
});

test("the first tap downloads Apple's model with progress and does not open the microphone", async () => {
  mockNative.availability.mockImplementation(async () => ({ available: true, installed: false }));
  let finishDownload = () => {};
  mockNative.install.mockImplementation(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
  const view = render(<Composer />);
  const mic = await view.findByLabelText("Dictate");
  await act(async () => { fireEvent.press(mic); });
  emit({ kind: "download", fraction: 0.42 });
  expect(view.getByText(/Downloading Apple's English speech model · 42%/)).toBeTruthy();
  await act(async () => { finishDownload(); });
  expect(mockNative.start).not.toHaveBeenCalled();
  expect(view.getByText("Apple's speech model is ready. Tap the microphone to talk.")).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByLabelText("Dictate")); });
  expect(mockNative.start).toHaveBeenCalledTimes(1);
});

test("a model iOS removed since is downloaded again on the next tap", async () => {
  mockNative.start.mockImplementationOnce(async () => { throw new Error("Apple's English speech model needs to be downloaded again."); });
  const view = render(<Composer />);
  const mic = await view.findByLabelText("Dictate");
  await act(async () => { fireEvent.press(mic); });
  expect(view.getByText("Apple's English speech model needs to be downloaded again.")).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByLabelText("Dictate")); });
  expect(mockNative.install).toHaveBeenCalledTimes(1);
});

test("a refused microphone says how to allow it", async () => {
  mockNative.start.mockImplementationOnce(async () => { throw new Error("Microphone access is off. Turn it on for Shahi in Settings to dictate."); });
  const view = render(<Composer />);
  const mic = await view.findByLabelText("Dictate");
  await act(async () => { fireEvent.press(mic); });
  expect(view.getByText(/Microphone access is off/)).toBeTruthy();
  expect(view.getByText("Open Settings")).toBeTruthy();
});
