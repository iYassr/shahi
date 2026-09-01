import { describe, expect, test } from "bun:test";
import { PromptReceipts, SUBMIT_DELAY_MS, submitPrompt } from "./prompt";

/**
 * Which herdr calls a prompt turns into, and when.
 *
 * The phone used to make this decision with two requests and a fixed pause; it
 * now makes one request and the sidecar decides. The cases here are the ones
 * that were measured or reported: codex needing the pause, and herdr refusing
 * `agent.prompt` for a blocked agent.
 */
function fakeRpc(fail: Record<string, string> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (fail[method]) throw new Error(`herdr ${method} failed: ${fail[method]}`);
    return {};
  };
  return { rpc, calls };
}

const noSleep = { slept: [] as number[] };
const sleep = async (ms: number) => void noSleep.slept.push(ms);

describe("submitPrompt", () => {
  test("an agent gets one agent.prompt and no pause", async () => {
    const { rpc, calls } = fakeRpc();
    noSleep.slept = [];
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "idle" }, "run the tests", sleep);
    expect(path).toBe("agent");
    expect(calls).toEqual([{ method: "agent.prompt", params: { target: "w1:p1", text: "run the tests" } }]);
    expect(noSleep.slept).toEqual([]);
  });

  test("a shell gets text, the pause, then Enter — in that order", async () => {
    const { rpc, calls } = fakeRpc();
    noSleep.slept = [];
    const path = await submitPrompt(rpc, { paneId: "w1:p3", isAgent: false, status: null }, "ls", sleep);
    expect(path).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
    expect(calls[1]!.params).toEqual({ pane_id: "w1:p3", keys: ["Enter"] });
    expect(noSleep.slept).toEqual([SUBMIT_DELAY_MS]);
  });

  // herdr 0.8.2: "If the agent is already blocked, submission is rejected with
  // agent_blocked before any input is sent." Typing an answer into a waiting
  // agent is what the composer is for, so blocked means the terminal path.
  test("a blocked agent is typed at, not prompted", async () => {
    const { rpc, calls } = fakeRpc();
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "blocked" }, "yes", sleep);
    expect(path).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  });

  test("agent_blocked from herdr falls back to the terminal path", async () => {
    const { rpc, calls } = fakeRpc({ "agent.prompt": "agent_blocked" });
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "idle" }, "yes", sleep);
    expect(path).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["agent.prompt", "pane.send_text", "pane.send_keys"]);
  });

  test("any other agent.prompt failure is the caller's to report", async () => {
    const { rpc } = fakeRpc({ "agent.prompt": "agent_not_found" });
    await expect(
      submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "working" }, "x", sleep),
    ).rejects.toThrow("agent_not_found");
  });
});

describe("PromptReceipts", () => {
  test("a retried clientMessageId gets the first receipt back", () => {
    const receipts = new PromptReceipts<{ acceptedAt: number }>();
    receipts.put("w1:p1:abc", { acceptedAt: 1 }, 1000);
    expect(receipts.get("w1:p1:abc", 2000)).toEqual({ acceptedAt: 1 });
  });

  test("receipts expire", () => {
    const receipts = new PromptReceipts<number>(1_000);
    receipts.put("a", 1, 0);
    expect(receipts.get("a", 999)).toBe(1);
    expect(receipts.get("a", 1_001)).toBeUndefined();
  });

  test("the table is bounded, oldest out first", () => {
    const receipts = new PromptReceipts<number>(60_000, 2);
    receipts.put("a", 1, 0);
    receipts.put("b", 2, 1);
    receipts.put("c", 3, 2);
    expect(receipts.get("a", 3)).toBeUndefined();
    expect(receipts.get("b", 3)).toBe(2);
    expect(receipts.get("c", 3)).toBe(3);
  });
});
