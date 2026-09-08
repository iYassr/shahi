import { describe, expect, test } from "bun:test";
import type { LogMessage } from "../api";
import { merge } from "./Reader";

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

describe("reader update identity", () => {
  test("an unchanged tail retains the loaded array and all message objects", () => {
    const current = [message("old"), message("a"), message("b")];
    expect(merge(current, [message("a"), message("b")])).toBe(current);
  });
  test("a same-length text edit updates only the edited message", () => {
    const current = [message("old"), message("a", "hello")];
    const next = merge(current, [message("a", "world")]);
    expect(next[0]).toBe(current[0]);
    expect(next[1]).not.toBe(current[1]);
    expect(next[1]!.blocks).toEqual([{ kind: "text", text: "world" }]);
  });
  test("tool results arriving invalidate the message", () => {
    const current: LogMessage[] = [{ ...message("a"), blocks: [{ kind: "tool", name: "Bash", summary: "ls", result: null }] }];
    const finished: LogMessage = { ...message("a"), blocks: [{ kind: "tool", name: "Bash", summary: "ls", result: { text: "file", isError: false, truncated: false, images: [] } }] };
    expect(merge(current, [finished])[0]).toBe(finished);
  });
});
