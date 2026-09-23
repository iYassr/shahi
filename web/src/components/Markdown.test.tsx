import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { inline, linkTarget, Markdown } from "./Markdown";

/**
 * Flattens rendered nodes to `type:text` pairs.
 *
 * React elements are plain objects, so this needs no DOM — which keeps the
 * whole web test suite runnable under `bun test`.
 */
function flatten(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [`text:${node}`];
  if (Array.isArray(node)) return node.flatMap(flatten);

  const element = node as ReactElement<{ children?: ReactNode }>;
  const inner = flatten(element.props.children);
  if (typeof element.type !== "string") return inner; // Fragment
  return inner.map((part) => `${element.type as string}:${part.replace(/^text:/, "")}`);
}

describe("inline", () => {
  test("marks up bold, italic and code", () => {
    expect(flatten(inline("a **b** c `d` e _f_"))).toEqual([
      "text:a ",
      "strong:b",
      "text: c ",
      "code:d",
      "text: e ",
      "em:f",
    ]);
  });

  test("keeps every span on a line with many of them", () => {
    // The recursive version bailed out partway along a line like this and left
    // the remaining `**` markers visible. Seven spans is not unusual in agent
    // prose; this asserts the scan does not run out.
    const line = "`a` **b** `c` **d** `e` **f** `g` **h**";
    const kinds = flatten(inline(line)).map((part) => part.split(":")[0]);
    expect(kinds.filter((k) => k === "code")).toHaveLength(4);
    expect(kinds.filter((k) => k === "strong")).toHaveLength(4);
    expect(flatten(inline(line)).join("")).not.toContain("*");
  });

  test("code wins over emphasis inside it", () => {
    expect(flatten(inline("`a * b * c`"))).toEqual(["code:a * b * c"]);
  });

  test("links render with their href, opening safely in a new tab", async () => {
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<>{inline("see [docs](https://example.com/x) now")}</>); });
    const anchor = view.root.findByType("a");
    expect(anchor.props.href).toBe("https://example.com/x");
    expect(anchor.props.rel).toBe("noreferrer noopener");
    expect(anchor.children.join("")).toBe("docs");
    await act(async () => view.unmount());
  });

  test("text without markers passes straight through", () => {
    expect(flatten(inline("plain words"))).toEqual(["text:plain words"]);
  });
});

// Review finding F106: agents link the files they touched as paths on the
// computer. The native reader opened them; the web reader showed bracket text.
describe("links to files on the computer", () => {
  test("absolute and home-relative paths are files; web URLs stay URLs; nothing else is a link", () => {
    expect(linkTarget("/Users/me/proj/src/api.ts")).toEqual({ kind: "file", path: "/Users/me/proj/src/api.ts" });
    expect(linkTarget("~/notes/today.md")).toEqual({ kind: "file", path: "~/notes/today.md" });
    expect(linkTarget("<~/a b.md>")).toEqual({ kind: "file", path: "~/a b.md" });
    expect(linkTarget("/srv/app/main.go#L12-L40")).toEqual({ kind: "file", path: "/srv/app/main.go" });
    expect(linkTarget("/tmp/r%C3%A9sum%C3%A9.pdf")).toEqual({ kind: "file", path: "/tmp/résumé.pdf" });
    expect(linkTarget("/tmp/100%.txt")).toEqual({ kind: "file", path: "/tmp/100%.txt" });
    expect(linkTarget("https://example.com/x")).toEqual({ kind: "url", href: "https://example.com/x" });
    for (const other of ["//evil.example/x", "file:///etc/passwd", "javascript:alert(1)", "relative/path.ts", "mailto:a@b.c"]) {
      expect(linkTarget(other)).toBeNull();
    }
  });

  test("a path link opens the file viewer, and without one it is just text", async () => {
    const opened: { path: string; name: string }[] = [];
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<Markdown text="Edited [api.ts](/Users/me/proj/src/api.ts) today." onOpenFile={(f) => opened.push(f)} />); });
    const link = view.root.findAllByType("button").find((b) => b.children.join("") === "api.ts")!;
    await act(async () => link.props.onClick());
    expect(opened).toEqual([{ path: "/Users/me/proj/src/api.ts", name: "api.ts" }]);
    await act(async () => view.unmount());

    await act(async () => { view = create(<Markdown text="Edited [api.ts](/Users/me/proj/src/api.ts) today." />); });
    expect(view.root.findAllByType("button")).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain("api.ts");
    await act(async () => view.unmount());
  });
});
