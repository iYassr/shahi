import { expect, test } from "bun:test";
import { homePath, rowPreview } from "./pane-title";

test("a new agent's row says it has no messages, not its whole working folder", () => {
  expect(rowPreview({ isAgent: true, preview: null, cwd: "/Users/me/shahi-device-test/claude-settings-error" })).toBe("No messages yet");
  expect(rowPreview({ isAgent: true, preview: "ready", cwd: "/Users/me/x" })).toBe("ready");
});

test("a shell keeps its folder, written from home", () => {
  expect(rowPreview({ isAgent: false, preview: null, cwd: "/Users/me/projects/shahi" })).toBe("~/projects/shahi");
  expect(rowPreview({ isAgent: false, preview: null, cwd: "/home/me" })).toBe("~");
  expect(rowPreview({ isAgent: false, preview: null, cwd: "/opt/work" })).toBe("/opt/work");
  expect(rowPreview({ isAgent: false, preview: null, cwd: null })).toBeNull();
  expect(homePath("/Users/meet/x")).toBe("~/x");
});
