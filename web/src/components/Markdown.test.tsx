import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { inline } from "./Markdown";

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

  test("links render with their href", () => {
    const node = inline("see [docs](https://example.com/x) now") as ReactElement<{
      children: ReactNode[];
    }>;
    const anchor = node.props.children.find(
      (child) => (child as ReactElement).type === "a",
    ) as ReactElement<{ href: string }>;
    expect(anchor.props.href).toBe("https://example.com/x");
  });

  test("text without markers passes straight through", () => {
    expect(flatten(inline("plain words"))).toEqual(["text:plain words"]);
  });
});
