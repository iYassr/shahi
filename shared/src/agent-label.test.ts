import { expect, test } from "bun:test";
import { defaultAgentKind } from "./agent-label";

const installed = ["agy", "claude", "codex", "cursor", "opencode"];

// Simulator run of build 32: the form started on Antigravity because it
// sorted first, whatever the person used.
test("a new agent form starts on the agent last started on this computer", () => {
  expect(defaultAgentKind(installed, "codex")).toBe("codex");
});

test("with nothing remembered, it starts on Claude, not the first alphabetically", () => {
  expect(defaultAgentKind(installed, null)).toBe("claude");
  expect(defaultAgentKind(installed, undefined)).toBe("claude");
});

test("an agent remembered but no longer installed is not offered", () => {
  expect(defaultAgentKind(installed, "gemini")).toBe("claude");
  expect(defaultAgentKind(["codex", "opencode"], "gemini")).toBe("codex");
  expect(defaultAgentKind([], "claude")).toBeNull();
});
