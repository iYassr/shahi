import { render } from "@testing-library/react-native";
import type { LogBlock } from "@shahi/shared";
import { Block } from "./pane";

/**
 * Every block kind the reader can be handed.
 *
 * Three of these were ported from the PWA without ever running: the question
 * card, the file row, and the tool result. A codex approval showing as a bare
 * question with nothing to judge is the failure this is here to catch.
 */
const openFile = jest.fn();

/*
 * The queries come from `render`'s return value rather than the module-level
 * `screen`, which stays empty under this preset — `screen` and `render` end up
 * looking at different module instances, and the symptom is the unhelpful
 * "`render` function has not been called" on a component that rendered fine.
 */
const draw = (block: LogBlock) =>
  render(<Block block={block} paneId="w1:p1" onOpenFile={openFile} />);

describe("the blocks a transcript is made of", () => {
  beforeEach(() => openFile.mockReset());

  test("text renders as text", () => {
    const view = draw({ kind: "text", text: "the agent said this" });
    expect(view.getByText(/the agent said this/)).toBeTruthy();
  });

  test("thinking is collapsed until asked for", () => {
    const view = draw({ kind: "thinking", text: "a private deliberation" });
    expect(view.queryByText("a private deliberation")).toBeNull();
    expect(view.getByText(/Thinking/)).toBeTruthy();
  });

  test("a tool call shows its name and summary without expanding", () => {
    const view = draw({
      kind: "tool",
      name: "Read",
      summary: "server/lib/http.ts",
      result: { text: "…", isError: false, truncated: false, images: [] },
    });
    expect(view.getByText("Read")).toBeTruthy();
    expect(view.getByText("server/lib/http.ts")).toBeTruthy();
  });

  test("a failed call says so on the collapsed row", () => {
    const view = draw({
      kind: "tool",
      name: "Bash",
      summary: "rm -rf /",
      result: { text: "refused", isError: true, truncated: false, images: [] },
    });
    expect(view.getByText("failed")).toBeTruthy();
  });

  // The question card: this is the agent talking to you, not a tool call, and
  // it must never be behind a caret.
  test("a question is shown in full, with its options numbered", () => {
    const view = draw({
      kind: "tool",
      name: "AskUserQuestion",
      summary: "",
      result: null,
      questions: [
        {
          text: "Which colour?",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Green" },
          ],
        },
      ],
    });
    expect(view.getByText("Which colour?")).toBeTruthy();
    expect(view.getByText(/Red/)).toBeTruthy();
    expect(view.getByText(/Green/)).toBeTruthy();
    expect(view.getByText("Warm")).toBeTruthy();
  });

  // The file row sits outside the collapsed section deliberately: on a phone it
  // is usually the part you wanted.
  test("a named file is offered without expanding anything", () => {
    const view = draw({
      kind: "tool",
      name: "Read",
      summary: "…",
      file: { path: "/home/y/notes.md", name: "notes.md" },
      result: null,
    });
    expect(view.getByText("notes.md")).toBeTruthy();
  });

  test("a tool call with no file offers nothing to open", () => {
    const view = draw({ kind: "tool", name: "Bash", summary: "ls", result: null });
    expect(view.queryByText("open")).toBeNull();
  });
});
