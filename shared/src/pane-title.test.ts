import { expect, test } from "bun:test";
import { homePath, paneTitle, rowPreview } from "./pane-title";

// Simulator run of build 32: before an agent named its conversation, its row
// was its launch command, flags and all.
test("a new agent titled by its launch command is called by the agent's name", () => {
  const pane = (title: string | null, agent: string | null = "claude") => ({ paneId: "w1:p2", title, agent });
  expect(paneTitle(pane("claude --permission-mode manual"))).toBe("Claude");
  expect(paneTitle(pane("claude"))).toBe("Claude");
  expect(paneTitle(pane("/Users/me/.local/bin/claude --dangerously-skip-permissions"))).toBe("Claude");
  expect(paneTitle(pane("codex --sandbox read-only --ask-for-approval on-request -c approvals_reviewer=\"user\"", "codex"))).toBe("Codex");
  expect(paneTitle(pane("cursor-agent --force", "cursor"))).toBe("Cursor");
  expect(paneTitle(pane("agy", "agy"))).toBe("Antigravity");
});

test("a conversation's own title passes through, even one that mentions its agent", () => {
  const pane = (title: string | null, agent: string | null = "claude") => ({ paneId: "w1:p2", title, agent });
  expect(paneTitle(pane("Tip calculator bug"))).toBe("Tip calculator bug");
  expect(paneTitle(pane("Describe tip.py | tip-calc"))).toBe("Describe tip.py | tip-calc");
  expect(paneTitle(pane("Claude Code"))).toBe("Claude Code");
  expect(paneTitle(pane("claude review of the parser"))).toBe("claude review of the parser");
  // Another program's command line is not this agent's.
  expect(paneTitle(pane("codex --sandbox read-only"))).toBe("codex --sandbox read-only");
  // A shell keeps whatever it ran; only an agent has a name to fall back to.
  expect(paneTitle(pane("vim --clean", null))).toBe("vim --clean");
  expect(paneTitle(pane("   "))).toBe("w1:p2");
  expect(paneTitle({ paneId: "w1:p3", title: "claude --resume" })).toBe("claude --resume");
});

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
