import { describe, expect, test } from "bun:test";
import type { LogMessage } from "../api";
import { merge, signature } from "./Reader";

const message = (id: string, text = "hello"): LogMessage => ({
  id,
  role: "agent",
  at: 0,
  blocks: [{ kind: "text", text }],
});

describe("merge", () => {
  test("takes the page when nothing is on screen yet", () => {
    const page = [message("a"), message("b")];
    expect(merge([], page)).toEqual(page);
  });

  test("keeps messages older than the page", () => {
    // The shape that was broken: "Load earlier" fetched these, and the next
    // poll — which only ever sees the newest page — threw them away.
    const older = [message("older-1"), message("older-2")];
    const page = [message("b"), message("c")];
    expect(merge([...older, ...page], page).map((m) => m.id)).toEqual([
      "older-1",
      "older-2",
      "b",
      "c",
    ]);
  });

  test("prefers the page's version of a message still being written", () => {
    const merged = merge([message("a", "partial")], [message("a", "partial and then some")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.blocks[0]).toEqual({ kind: "text", text: "partial and then some" });
  });

  test("appends messages that arrived since the last poll", () => {
    expect(merge([message("a")], [message("a"), message("b")]).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("signature", () => {
  test("is stable when nothing changed", () => {
    const before = [message("a"), message("b")];
    const after = [message("a"), message("b")];
    expect(signature(after)).toBe(signature(before));
  });

  test("notices text growing as an agent writes", () => {
    expect(signature([message("a", "half")])).not.toBe(signature([message("a", "half a sentence")]));
  });

  test("notices a new block on an existing message", () => {
    const withTool: LogMessage = {
      ...message("a"),
      blocks: [
        { kind: "text", text: "hello" },
        { kind: "tool", name: "Bash", summary: "ls", result: null },
      ],
    };
    expect(signature([withTool])).not.toBe(signature([message("a")]));
  });

  test("notices tool output arriving", () => {
    const running: LogMessage = {
      ...message("a"),
      blocks: [{ kind: "tool", name: "Bash", summary: "ls", result: null }],
    };
    const finished: LogMessage = {
      ...message("a"),
      blocks: [
        {
          kind: "tool",
          name: "Bash",
          summary: "ls",
          result: { text: "a\nb\nc", isError: false, truncated: false, images: [] },
        },
      ],
    };
    expect(signature([finished])).not.toBe(signature([running]));
  });
});
