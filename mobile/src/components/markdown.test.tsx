import { fireEvent, render } from "@testing-library/react-native";
import { Linking } from "react-native";
import { Markdown } from "./markdown";

/**
 * The renderer that turns agent prose into native elements.
 *
 * The grammar mirrors the web renderer's, but none of that code came across —
 * only the approach — so the web suite proves nothing about this file. The
 * cases here are the ones that came from real transcripts: the unclosed fence
 * of an agent mid-stream, the seven-span line the recursive renderer gave up
 * on, and prose that merely contains pipes.
 */
const draw = (text: string) => render(<Markdown text={text} />);

describe("blocks", () => {
  test("plain prose is a paragraph", () => {
    expect(draw("just some words").getByText("just some words")).toBeTruthy();
  });

  test("a heading loses its hashes", () => {
    const view = draw("## Deploys");
    expect(view.getByText("Deploys")).toBeTruthy();
    expect(view.queryByText(/##/)).toBeNull();
  });

  test("fenced code keeps its body verbatim, markers and all", () => {
    const view = draw("```\nconst x = a ** b;\n```");
    expect(view.getByText("const x = a ** b;")).toBeTruthy();
  });

  // An agent mid-stream has written the opening fence and not yet the closing
  // one. The text so far must render rather than vanish until the fence closes.
  test("an unclosed fence still shows what has arrived", () => {
    const view = draw("```\nstill streaming");
    expect(view.getByText("still streaming")).toBeTruthy();
  });

  test("bullets and numbers keep their markers apart", () => {
    const view = draw("- first\n2. second");
    expect(view.getByText("first")).toBeTruthy();
    expect(view.getByText("•")).toBeTruthy();
    expect(view.getByText("2.")).toBeTruthy();
    expect(view.getByText("second")).toBeTruthy();
  });

  test("a blockquote renders its text without the marker", () => {
    const view = draw("> quoted words");
    expect(view.getByText("quoted words")).toBeTruthy();
  });

  test("a table needs its divider row; the cells come through, the pipes do not", () => {
    const view = draw("| name | port |\n| --- | --- |\n| shahi | 7171 |");
    expect(view.getByText("name")).toBeTruthy();
    expect(view.getByText("shahi")).toBeTruthy();
    expect(view.getByText("7171")).toBeTruthy();
    expect(view.queryByText(/\|/)).toBeNull();
  });

  // The divider is what separates a table from prose that mentions pipes —
  // shell one-liners do constantly, and each was rendering as a one-row table.
  test("prose containing pipes is left alone", () => {
    const view = draw("| this is not | a table |");
    expect(view.getByText("| this is not | a table |")).toBeTruthy();
  });
});

describe("inline spans", () => {
  test("bold, italic and code are lifted out of the text", () => {
    const view = draw("a **bold** and _slanted_ and `mono` word");
    expect(view.getByText("bold")).toBeTruthy();
    expect(view.getByText("slanted")).toBeTruthy();
    expect(view.getByText("mono")).toBeTruthy();
    expect(view.queryByText(/\*\*/)).toBeNull();
  });

  // The recursive renderer spent a guard per span and gave up partway along a
  // line like this, leaving `**` visible from the seventh span on. Seen on a
  // real transcript; the scan must not run out.
  test("a line with many spans keeps every one", () => {
    const view = draw("`a` **b** `c` **d** `e` **f** `g` **h**");
    for (const span of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(view.getByText(span)).toBeTruthy();
    }
    expect(view.queryByText(/[*`]/)).toBeNull();
  });

  test("code wins over emphasis, so backticked asterisks stay literal", () => {
    const view = draw("run `ls *.ts` first");
    expect(view.getByText("ls *.ts")).toBeTruthy();
  });

  test("a link shows its label and opens its URL when pressed", () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    const view = draw("see [the docs](https://example.com/x) for more");
    fireEvent.press(view.getByText("the docs"));
    expect(openURL).toHaveBeenCalledWith("https://example.com/x");
    expect(view.queryByText(/https:/)).toBeNull();
    openURL.mockRestore();
  });

  test("an underscore inside a word does not start italics", () => {
    const view = draw("the pane_id field");
    expect(view.getByText("the pane_id field")).toBeTruthy();
  });
});
