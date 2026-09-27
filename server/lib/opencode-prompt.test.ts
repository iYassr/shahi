import { expect, test } from "bun:test";
import { parsePrompt, stripAnsi } from "./prompt-parser";
import { answerPrompt, keysFor } from "./answer";
import { openCodeMenu } from "../fixtures/provider-menus";

for (const selected of [0, 1, 2]) {
  test(`OpenCode answers from highlighted column ${selected + 1}, never assumes the initial choice`, async () => {
    const screen = openCodeMenu(selected);
    const parsed = parsePrompt(screen)!;
    expect(parsed.answer).toBe("horizontal");
    expect(parsed.options.findIndex(option => option.selected)).toBe(selected);
    expect(parsed.context).toEqual(["→ Edit denied.txt\n\n 1 + DENIED_WRITE"]);
    const writes: unknown[] = [];
    const rpc = async (method: string, params: unknown) => {
      if (method === "pane.read") return { read: { text: screen } };
      writes.push(params);
    };
    const keys = Array.from({ length: 2 - selected }, () => "Right").concat("Enter");
    expect(await answerPrompt(rpc, "w1:p1", { index: 3, label: "Reject" }, { settleMs: 0 })).toEqual(keys);
    expect(writes).toEqual([{ pane_id: "w1:p1", keys }]);
    expect(keysFor(parsed, parsed.options[0]!)).toEqual(Array.from({ length: selected }, () => "Left").concat("Enter"));
  });
}

test("OpenCode recognises themes by relative background, not a hardcoded highlight colour", () => {
  for (const color of ["48;2;17;45;64", "48;5;99", "44", "104"]) {
    expect(parsePrompt(openCodeMenu(1, color))?.options[1]?.selected).toBe(true);
  }
});

test("OpenCode requires both its permission frame and exactly one coloured choice", () => {
  expect(parsePrompt(stripAnsi(openCodeMenu()))).toBeNull();
  expect(parsePrompt(openCodeMenu(0, "48;2;30;30;30"))).toBeNull();
  expect(parsePrompt(openCodeMenu().replace("△ Permission required", "An example"))).toBeNull();
  expect(parsePrompt(openCodeMenu().replace("enter confirm", "example"))).toBeNull();
});
