import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ParsedPrompt } from "../api";
import { Prompt } from "./Prompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
});

const prompt: ParsedPrompt = {
  question: "Which colour do you prefer?", promptId: "same-question", answer: "digit",
  options: [
    { index: 1, label: "Red", selected: true },
    { index: 2, label: "Green", selected: false },
    { index: 3, label: "Type something.", selected: false, textInput: true },
  ],
};
const buttons = () => view!.root.findAllByType("button");
async function render(onAnswer: (index: number) => Promise<void>) {
  await act(async () => { view = create(<Prompt prompt={prompt} onAnswer={onAnswer} />); });
}

test("a completed editable-field selection allows changing to a predefined answer", async () => {
  let selectField!: () => void;
  const onAnswer = mock((index: number) => index === 3 ? new Promise<void>(resolve => { selectField = resolve; }) : Promise.resolve());
  await render(onAnswer);
  await act(async () => buttons()[2]!.props.onClick());
  expect(buttons().map(button => button.props.disabled)).toEqual([true, true, true]);
  expect(onAnswer.mock.calls).toEqual([[3]]);
  await act(async () => selectField());
  expect(buttons().map(button => button.props.disabled)).toEqual([false, false, false]);
  await act(async () => buttons()[0]!.props.onClick());
  expect(onAnswer.mock.calls).toEqual([[3], [1]]);
  expect(buttons().map(button => button.props.disabled)).toEqual([true, true, true]);
});

test("an ordinary answer remains latched so a second choice cannot send a stray key", async () => {
  const onAnswer = mock(async () => {});
  await render(onAnswer);
  await act(async () => buttons()[0]!.props.onClick());
  expect(buttons()[0]!.props["data-armed"]).toBe(true);
  expect(buttons().every(button => button.props.disabled)).toBe(true);
  await act(async () => buttons()[1]!.props.onClick());
  expect(onAnswer.mock.calls).toEqual([[1]]);
});

test("a failed selection restores the question and permits retry", async () => {
  const onAnswer = mock().mockRejectedValueOnce(new Error("selection not delivered")).mockResolvedValue(undefined);
  await render(onAnswer);
  await act(async () => buttons()[0]!.props.onClick());
  expect(buttons().map(button => button.props.disabled)).toEqual([false, false, false]);
  expect(buttons()[0]!.props["data-selected"]).toBe(true);
  await act(async () => buttons()[0]!.props.onClick());
  expect(onAnswer.mock.calls).toEqual([[1], [1]]);
  expect(buttons().every(button => button.props.disabled)).toBe(true);
});
