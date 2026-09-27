import { describe, expect, test } from "bun:test";
import { parsePrompt } from "./prompt-parser";
import { providerIsWaiting, providerPrompt } from "./provider-prompts";
import { answerPrompt, keysFor } from "./answer";
import { Poller } from "./poller";
import { TranscriptStore } from "./transcript";
import type { HerdrClient } from "./herdr-client";
import type { SessionStore } from "./state";

import { CODEX_TRUST, CURSOR_TRUST, AGY_TRUST, CURSOR_COMMAND, AGY_EDIT, AGY_COMMAND } from "../fixtures/provider-menus";

const cases = [
  { kind: "agy", screen: AGY_COMMAND, question: "Run this command?", keys: [["1"], ["2"], ["3"], ["4"]] },
  { kind: "codex", screen: CODEX_TRUST, question: "Trust this folder?", keys: [["1", "Enter"], ["2", "Enter"]] },
  { kind: "cursor", screen: CURSOR_TRUST, question: "Do you trust", keys: [["a"], ["q"]] },
  { kind: "agy", screen: AGY_TRUST, question: "Do you trust", keys: [["Enter"], ["Down", "Enter"]] },
  { kind: "cursor", screen: CURSOR_COMMAND, question: "Run this command?", keys: [["y"], ["Tab"], ["shift+tab"], ["n"]] },
  { kind: "agy", screen: AGY_EDIT, question: "Accept this file edit?", keys: [["1"], ["2"]] },
];

describe("current provider menus", () => {
  for (const { kind, screen, question, keys } of cases) {
    test(`${kind}: ${question} is actionable despite stale herdr status`, async () => {
      const parsed = parsePrompt(screen)!;
      expect(parsed.question).toStartWith(question);
      expect(parsed.options.map(option => keysFor(parsed, option))).toEqual(keys);
      expect(providerIsWaiting(kind, screen, parsed)).toBe(true);
      expect(providerIsWaiting("different-provider", screen, parsed)).toBe(false);
      const shown = { text: screen };
      const client = { rpc: async (method: string) => method === "pane.get" ? { pane: { agent_status: "idle" } } : { read: { text: shown.text } } } as unknown as HerdrClient;
      const store = { pane: () => ({ agent: kind, agent_status: "idle" }), instance: () => undefined } as unknown as SessionStore;
      const poller = new Poller(client, store, new TranscriptStore(":memory:"));
      expect((await poller.refresh("w1:p1"))?.prompt?.question).toBe(parsed.question);
      expect((await poller.refresh("w1:p1"))?.prompt?.question).toBe(parsed.question);
      shown.text = "Ready for your next message";
      expect((await poller.refresh("w1:p1"))?.prompt).toBeNull();
    });
  }

  test("Codex retains the folder and wrapped warning above empty terminal padding", () => {
    const parsed = parsePrompt(CODEX_TRUST)!;
    expect(parsed.context).toEqual(["/home/test/project"]);
    expect(parsed.question).toEndWith("decision will be saved.");
    expect(parsed.confirm).toBe(true);
  });

  test("Cursor retains the command and the batch being approved", () => {
    expect(parsePrompt(CURSOR_COMMAND)?.context).toEqual(["Approval 1 of 3", '$ python3 -c "print(\'probe\')" in .', "Not in allowlist: python3"]);
    expect(parsePrompt(CURSOR_COMMAND.replace("Approval 1 of 3\n", ""))?.context?.[0]).toStartWith("$ python3");
  });

  test("shortcut answers are computed from a fresh menu, including older clients", async () => {
    const calls: unknown[] = [];
    const rpc = async (method: string, params: unknown) => {
      if (method === "pane.read") return { read: { text: CURSOR_COMMAND } };
      calls.push(params);
    };
    expect(await answerPrompt(rpc, "w1:p1", { index: 4, label: "Skip & tell the agent what to do instead (esc or n)" }, { settleMs: 0 })).toEqual(["n"]);
    expect(calls).toEqual([{ pane_id: "w1:p1", keys: ["n"] }]);
    expect(() => keysFor({ answer: "key" } as never, { key: "Enter" } as never)).toThrow("Unrecognised");
  });

  test("partial menus and prose cannot override herdr's status", () => {
    const altered = [
      CODEX_TRUST.replace("enter continue · esc back", "Enter something"),
      CODEX_TRUST.replace("2. Back", "1. Back"),
      CURSOR_TRUST.replace("[q] Quit", "[q] Trust this workspace"),
      CURSOR_TRUST.replace("Use arrow keys", "Use other keys"),
      CURSOR_COMMAND.replace("────────────────────────────────────────", "command example"),
      CURSOR_COMMAND.replace("→ Run", "Run"),
      CURSOR_COMMAND.replace("    Run Everything", "  → Run Everything"),
      AGY_TRUST.replace("↑/↓ Navigate · enter Confirm", "Continue"),
      AGY_TRUST.replace("/home/test/project", "A project"),
    ];
    for (const screen of altered) expect(providerPrompt(screen.trimEnd().split("\n"))).toBeNull();
  });
});

test("Cursor's skip feedback remains a typed field even when herdr says working", async () => {
  const { CURSOR_FEEDBACK } = await import("../fixtures/provider-menus");
  const { submitPrompt } = await import("./prompt");
  const parsed = parsePrompt(CURSOR_FEEDBACK)!;
  expect(parsed.options[0]?.textInput).toBe(true);
  expect(providerIsWaiting("cursor", CURSOR_FEEDBACK, parsed)).toBe(true);
  expect(keysFor(parsed, parsed.options[0]!)).toEqual([]);
  const writes: string[] = [];
  const rpc = async (method: string) => {
    if (method === "pane.read") return { read: { text: CURSOR_FEEDBACK } };
    writes.push(method);
  };
  await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "working", shellAlone: false }, "Do not run it; stop.", async () => {});
  expect(writes).toEqual(["pane.send_text", "pane.send_keys"]);
});

test("Antigravity also offers session and persistent deny choices after a rejection", async () => {
  const { AGY_COMMAND } = await import("../fixtures/provider-menus");
  const screen = AGY_COMMAND.replace("  4. No, cancel", "  4. No, cancel\n  5. No, and always deny for commands that start with 'node probe.mjs' in this conversation\n  6. No, and always deny for commands that start with 'node probe.mjs' (Persist to settings.json)");
  const parsed = parsePrompt(screen)!;
  expect(parsed.options).toHaveLength(6);
  expect(providerIsWaiting("agy", screen, parsed)).toBe(true);
  expect(keysFor(parsed, parsed.options[3]!)).toEqual(["4"]);
});

test("Cursor feedback can lose its hint only when the exact typed line replaces it", async () => {
  const { CURSOR_FEEDBACK } = await import("../fixtures/provider-menus");
  const { submitPrompt } = await import("./prompt");
  const { cursorFeedbackTyped } = await import("./provider-prompts");
  const before = `Earlier conversation\n\n${CURSOR_FEEDBACK}`;
  const typed = "Stop without writing.\n";
  const after = "Earlier conversation\n\n→ Stop without writing.\n\n";
  expect(cursorFeedbackTyped(before, after, typed)).toBe(true);
  expect(cursorFeedbackTyped(before, after.replace("Earlier", "Changed"), typed)).toBe(false);
  expect(cursorFeedbackTyped(before, after.replace("writing.", "running."), typed)).toBe(false);
  let screen = before;
  const writes: string[] = [];
  const rpc = async (method: string) => {
    if (method === "pane.read") return { read: { text: screen } };
    writes.push(method);
    if (method === "pane.send_text") screen = after;
  };
  await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "working", shellAlone: false }, typed, async () => {});
  expect(writes).toEqual(["pane.send_text", "pane.send_keys"]);
});
