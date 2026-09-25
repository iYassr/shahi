import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PromptOpen, SUBMIT_DELAY_MS, submitPrompt } from "./prompt";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

/**
 * Which herdr calls a prompt turns into, and when.
 *
 * The phone used to make this decision with two requests and a fixed pause; it
 * now makes one request and the sidecar decides. The cases here are the ones
 * that were measured or reported: codex needing the pause, and herdr refusing
 * `agent.prompt` for a blocked agent.
 */
function fakeRpc(fail: Record<string, string> = {}, screen = "") {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (fail[method]) throw new Error(`herdr ${method} failed: ${fail[method]}`);
    if (method === "pane.read") return { read: { text: screen } };
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
    // The screen is read first: see the next describe.
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "pane.send_text", "pane.send_keys"]);
  });

  test("agent_blocked from herdr falls back to the terminal path", async () => {
    const { rpc, calls } = fakeRpc({ "agent.prompt": "agent_blocked" });
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "idle" }, "yes", sleep);
    expect(path).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["agent.prompt", "pane.read", "pane.send_text", "pane.send_keys"]);
  });

  test("any other agent.prompt failure is the caller's to report", async () => {
    const { rpc } = fakeRpc({ "agent.prompt": "agent_not_found" });
    await expect(
      submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "working" }, "x", sleep),
    ).rejects.toThrow("agent_not_found");
  });
});

/**
 * Text then Enter at a menu answers the menu, with whatever row is lit.
 * Measured on Claude Code 2.1.280: at the Bash permission menu, cursor on
 * "1. Yes", typing "no" and pressing Enter ran the command. Screens are real
 * captures (see fixtures/README.md).
 */
describe("a message to an agent waiting on a menu", () => {
  const blocked = { paneId: "w1:p1", isAgent: true, status: "blocked" };
  const writes = (calls: { method: string }[]) => calls.filter((c) => c.method.startsWith("pane.send"));

  test("is refused rather than confirming the highlighted option, and nothing is typed", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__claude-bash__text.txt"));
    await expect(submitPrompt(rpc, blocked, "no, use yarn instead", sleep)).rejects.toBeInstanceOf(PromptOpen);
    expect(writes(calls)).toEqual([]);
  });

  test("is refused when herdr's agent_blocked is what shows the agent is waiting", async () => {
    const { rpc, calls } = fakeRpc({ "agent.prompt": "agent_blocked" }, fixture("blocked__claude-bash__text.txt"));
    await expect(
      submitPrompt(rpc, { ...blocked, status: "idle" }, "no", sleep),
    ).rejects.toBeInstanceOf(PromptOpen);
    expect(writes(calls)).toEqual([]);
  });

  // Its lit row is "No, exit": the Enter would quit the agent just started.
  test("is refused at the folder-trust menu", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__trust-folder__text.txt"));
    await expect(submitPrompt(rpc, blocked, "yes", sleep)).rejects.toBeInstanceOf(PromptOpen);
    expect(writes(calls)).toEqual([]);
  });

  // codex's approval rows answer to single letters: "yes" would approve at the "y".
  test("is refused at a codex approval", async () => {
    const { rpc } = fakeRpc({}, fixture("blocked__wE-p6__text.txt"));
    await expect(submitPrompt(rpc, blocked, "yes", sleep)).rejects.toBeInstanceOf(PromptOpen);
  });

  // Typing there does nothing (measured); Enter answers No and the text is lost.
  test("is refused on \"No, and tell Claude what to do differently\"", async () => {
    const { rpc } = fakeRpc({}, fixture("blocked__claude-webfetch-no__text.txt"));
    await expect(submitPrompt(rpc, blocked, "skip it", sleep)).rejects.toBeInstanceOf(PromptOpen);
  });

  // On these rows typed text replaces the label and Enter submits it (measured).
  test.each(["blocked__claude-ask-type__text.txt", "blocked__claude-plan-change__text.txt"])(
    "is typed when the lit row is a text field (%s)",
    async (screen) => {
      const { rpc, calls } = fakeRpc({}, fixture(screen));
      expect(await submitPrompt(rpc, blocked, "blue", sleep)).toBe("terminal");
      expect(writes(calls).map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
    },
  );

  // Pre-release bug hunt, B10: once the field held text ("❯ 3. 1") its label
  // no longer read "Type something.", and the composer was refused as well
  // as the buttons, leaving only the key bar.
  test("is typed into a text field that already holds text", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__claude-ask-typed__text.txt"));
    expect(await submitPrompt(rpc, blocked, "blue", sleep)).toBe("terminal");
    expect(writes(calls).map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  });

  // A shell is a terminal the person is driving; the text is theirs to send.
  test("is still typed into a shell whatever its screen shows", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__claude-bash__text.txt"));
    expect(await submitPrompt(rpc, { paneId: "w1:p3", isAgent: false, status: null }, "2", sleep)).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
  });
});
