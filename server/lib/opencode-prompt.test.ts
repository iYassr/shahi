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
    // The highlight follows each Right, and Enter closes the menu.
    let shown = screen;
    const rpc = async (method: string, params: { keys?: string[] }) => {
      if (method === "pane.read") return { read: { text: shown } };
      writes.push(params);
      shown = params.keys?.includes("Enter") ? "" : openCodeMenu(Math.min(2, selected + (params.keys?.length ?? 0)));
    };
    const moves = Array.from({ length: 2 - selected }, () => "Right");
    const keys = moves.concat("Enter");
    expect(await answerPrompt(rpc, "w1:p1", { index: 3, label: "Reject" }, { settleMs: 0, sleep: async () => {} })).toEqual(keys);
    // Enter only once the highlight was seen on Reject.
    expect(writes).toEqual(moves.length > 0 ? [{ pane_id: "w1:p1", keys: moves }, { pane_id: "w1:p1", keys: ["Enter"] }] : [{ pane_id: "w1:p1", keys }]);
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
