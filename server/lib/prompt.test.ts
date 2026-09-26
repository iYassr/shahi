import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PromptMoved, PromptOpen, promptTarget, SUBMIT_DELAY_MS, submitPrompt } from "./prompt";

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
    if (method === "pane.process_info") return { process_info: atPrompt };
    return {};
  };
  return { rpc, calls };
}

/** A shell at its prompt, as measured on 0.9.1: the foreground group is the shell's, and holds only it. */
const atPrompt = { shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "zsh" }] };
/** Claude Code started from that shell, in a group of its own. */
const claudeRunning = { shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ pid: 200, name: "claude" }] };

const noSleep = { slept: [] as number[] };
const sleep = async (ms: number) => void noSleep.slept.push(ms);

describe("submitPrompt", () => {
  test("an agent gets one agent.prompt and no pause, once its screen shows no menu", async () => {
    const { rpc, calls } = fakeRpc();
    noSleep.slept = [];
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "idle", shellAlone: false }, "run the tests", sleep);
    expect(path).toBe("agent");
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "agent.prompt"]);
    expect(calls[1]).toEqual({ method: "agent.prompt", params: { target: "w1:p1", text: "run the tests" } });
    expect(noSleep.slept).toEqual([]);
  });

  test("a shell gets text, the pause, then Enter — in that order", async () => {
    const { rpc, calls } = fakeRpc();
    noSleep.slept = [];
    const path = await submitPrompt(rpc, { paneId: "w1:p3", isAgent: false, status: null, shellAlone: true }, "ls", sleep);
    expect(path).toBe("terminal");
    // Who has the terminal is asked again before Enter: see the describes below.
    expect(calls.map((c) => c.method)).toEqual(["pane.send_text", "pane.process_info", "pane.send_keys"]);
    expect(calls[2]!.params).toEqual({ pane_id: "w1:p3", keys: ["Enter"] });
    expect(noSleep.slept).toEqual([SUBMIT_DELAY_MS]);
  });

  // herdr 0.8.2: "If the agent is already blocked, submission is rejected with
  // agent_blocked before any input is sent." Typing an answer into a waiting
  // agent is what the composer is for, so blocked means the terminal path.
  test("a blocked agent is typed at, not prompted", async () => {
    const { rpc, calls } = fakeRpc();
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "blocked", shellAlone: false }, "yes", sleep);
    expect(path).toBe("terminal");
    // The screen is read first and again before Enter: see the describes below.
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "pane.send_text", "pane.read", "pane.send_keys"]);
  });

  test("agent_blocked from herdr falls back to the terminal path", async () => {
    const { rpc, calls } = fakeRpc({ "agent.prompt": "agent_blocked" });
    const path = await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "idle", shellAlone: false }, "yes", sleep);
    expect(path).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "agent.prompt", "pane.read", "pane.send_text", "pane.read", "pane.send_keys"]);
  });

  test("any other agent.prompt failure is the caller's to report", async () => {
    const { rpc } = fakeRpc({ "agent.prompt": "agent_not_found" });
    await expect(
      submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status: "working", shellAlone: false }, "x", sleep),
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
  const blocked = { paneId: "w1:p1", isAgent: true, status: "blocked", shellAlone: false };
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

  // Pre-release bug hunt, B4: herdr reports a new agent `unknown` for its
  // first seconds, its trust menu already drawn, and `agent.prompt` typed the
  // text and pressed Enter on "No, exit". Only `blocked` used to be checked.
  test.each(["unknown", "idle", "working"])(
    "is refused at the folder-trust menu while herdr calls the agent %s",
    async (status) => {
      const { rpc, calls } = fakeRpc({}, fixture("blocked__trust-folder__text.txt"));
      await expect(submitPrompt(rpc, { ...blocked, status }, "please fix the tests", sleep)).rejects.toBeInstanceOf(PromptOpen);
      expect(calls.map((c) => c.method)).toEqual(["pane.read"]);
    },
  );

  test("is refused at a codex trust menu while herdr calls the agent unknown", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__codex-trust-folder__text.txt"));
    await expect(submitPrompt(rpc, { ...blocked, status: "unknown" }, "hi", sleep)).rejects.toBeInstanceOf(PromptOpen);
    expect(calls.map((c) => c.method)).toEqual(["pane.read"]);
  });

  // A question that takes text is typed into even before herdr says blocked:
  // `agent.prompt` would be refused or would drive the composer beneath it.
  test("is typed into a text field while herdr still calls the agent idle", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__claude-ask-type__text.txt"));
    expect(await submitPrompt(rpc, { ...blocked, status: "idle" }, "blue", sleep)).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "pane.send_text", "pane.read", "pane.send_keys"]);
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

  // A shell at its prompt is a terminal the person is driving, and a menu
  // above the prompt is output an earlier program left behind: nothing but
  // the shell reads the keys, so the text is theirs to send.
  test("is still typed into a shell at its prompt whatever its screen shows", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__claude-bash__text.txt"));
    const shell = { paneId: "w1:p3", isAgent: false, status: null, shellAlone: true };
    expect(await submitPrompt(rpc, shell, "2", sleep)).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.send_text", "pane.process_info", "pane.send_keys"]);
  });

  // Pre-release bug hunt, B4, re-verified: herdr names the agent 215–285ms
  // after Claude Code draws its trust menu. In that gap the pane was a shell
  // to the route, the text and Enter went in unread, and Claude Code quit 6
  // times in 6. The program holding the terminal is what is waiting.
  test("is refused at a trust menu drawn by a program herdr has not named an agent yet", async () => {
    const { rpc, calls } = fakeRpc({}, fixture("blocked__trust-folder__text.txt"));
    const program = { paneId: "w1:p3", isAgent: false, status: null, shellAlone: false };
    await expect(submitPrompt(rpc, program, "please fix the tests", sleep)).rejects.toBeInstanceOf(PromptOpen);
    expect(calls.map((c) => c.method)).toEqual(["pane.read"]);
  });

  test("is typed into a program that shows no menu, as into a shell", async () => {
    const { rpc, calls } = fakeRpc();
    const program = { paneId: "w1:p3", isAgent: false, status: null, shellAlone: false };
    expect(await submitPrompt(rpc, program, "print(1)", sleep)).toBe("terminal");
    expect(calls.map((c) => c.method)).toEqual(["pane.read", "pane.send_text", "pane.read", "pane.send_keys"]);
  });
});

/**
 * The screen is read again between the text and its Enter. A person at the
 * terminal does not wait for a phone's write to finish, and a cursor moved in
 * those 200ms turned the Enter into a choice nobody made (pre-release bug
 * hunt, B6). Nothing is pressed then, and the text is left where it was typed.
 */
describe("a message whose screen changes before its Enter", () => {
  const blocked = { paneId: "w1:p1", isAgent: true, status: "blocked", shellAlone: false };
  /** A pane showing `first`, then `then` from the moment the text is typed. */
  function changing(first: string, then: string) {
    const calls: string[] = [];
    let screen = first;
    const rpc = async (method: string) => {
      calls.push(method);
      if (method === "pane.read") return { read: { text: screen } };
      if (method === "pane.send_text") screen = then;
      return {};
    };
    return { rpc, calls };
  }

  test("a cursor moved off the text field during the submit delay: Enter is not pressed", async () => {
    // Up from "3. Type something." lands on "2. Green"; Enter would choose it.
    const field = fixture("blocked__claude-ask-type__text.txt");
    const moved = field.replace("  2. Green", "❯ 2. Green").replace("❯ 3. Type something.", "  3. Type something.");
    expect(moved).not.toBe(field);
    const { rpc, calls } = changing(field, moved);
    await expect(submitPrompt(rpc, blocked, "please use blue", sleep)).rejects.toBeInstanceOf(PromptMoved);
    expect(calls).toEqual(["pane.read", "pane.send_text", "pane.read"]);
  });

  test("a menu drawn during the submit delay: Enter is not pressed", async () => {
    const { rpc, calls } = changing("", fixture("blocked__claude-bash__text.txt"));
    await expect(submitPrompt(rpc, blocked, "carry on", sleep)).rejects.toBeInstanceOf(PromptMoved);
    expect(calls).not.toContain("pane.send_keys");
  });

  // A program started at the desk as the message arrived has the terminal
  // within 50ms, after the shell was asked, and reads the typed text and the
  // Enter as its own. Claude Code draws its trust menu inside the pause (4
  // times in 4, B4 re-verified), where that Enter would choose "No, exit".
  test("a program that takes a shell's terminal during the submit delay: Enter is not pressed", async () => {
    const calls: string[] = [];
    let info = atPrompt;
    const rpc = async (method: string) => {
      calls.push(method);
      if (method === "pane.send_text") info = claudeRunning;
      if (method === "pane.process_info") return { process_info: info };
      return {};
    };
    const shell = { paneId: "w1:p3", isAgent: false, status: null, shellAlone: true };
    await expect(submitPrompt(rpc, shell, "please fix the tests", sleep)).rejects.toBeInstanceOf(PromptMoved);
    expect(calls).toEqual(["pane.send_text", "pane.process_info"]);
  });

  // A program started just before the message has the terminal but has not
  // drawn its menu yet, so the first read finds nothing to refuse.
  test("a menu drawn in a program's pane during the submit delay: Enter is not pressed", async () => {
    const { rpc, calls } = changing("", fixture("blocked__trust-folder__text.txt"));
    const program = { paneId: "w1:p3", isAgent: false, status: null, shellAlone: false };
    await expect(submitPrompt(rpc, program, "please fix the tests", sleep)).rejects.toBeInstanceOf(PromptMoved);
    expect(calls).toEqual(["pane.read", "pane.send_text", "pane.read"]);
  });

  test("text typed into the field itself is still submitted", async () => {
    const { rpc, calls } = changing(fixture("blocked__claude-ask-type__text.txt"), fixture("blocked__claude-ask-typed__text.txt"));
    expect(await submitPrompt(rpc, blocked, "1", sleep)).toBe("terminal");
    expect(calls.at(-1)).toBe("pane.send_keys");
  });
});

/**
 * What the route asks herdr before choosing a path. The mirror is up to 3s
 * behind, and a just-started agent was still a shell in it, so its message was
 * typed onto the trust menu with no screen read (pre-release bug hunt, B4).
 */
describe("promptTarget", () => {
  const herdr = (pane: unknown, processInfo: unknown = atPrompt) => async (method: string) => {
    if (method === "pane.get") {
      if (pane instanceof Error) throw pane;
      return { pane };
    }
    if (method === "pane.process_info") {
      if (processInfo instanceof Error) throw processInfo;
      return { process_info: processInfo };
    }
    throw new Error(`unexpected ${method}`);
  };

  test("an agent herdr has started is an agent before the mirror has seen it", async () => {
    const rpc = herdr({ pane_id: "w1:p2", agent: "claude", agent_status: "unknown" });
    expect(await promptTarget(rpc, "w1:p2", undefined)).toEqual({ paneId: "w1:p2", isAgent: true, status: "unknown", shellAlone: false });
  });

  test("herdr's status is fresher than the mirror's", async () => {
    const rpc = herdr({ pane_id: "w1:p2", agent: "codex", agent_status: "blocked" });
    expect(await promptTarget(rpc, "w1:p2", { agent_status: "working" })).toMatchObject({ isAgent: true, status: "blocked" });
  });

  // The careful path: agent.prompt refuses a pane whose agent has gone,
  // rather than the text running in the shell left behind.
  test("the mirror's agent is kept when herdr names none", async () => {
    const rpc = herdr({ pane_id: "w1:p2", agent: null, agent_status: "unknown" });
    expect(await promptTarget(rpc, "w1:p2", { agent_status: "idle" })).toEqual({ paneId: "w1:p2", isAgent: true, status: "idle", shellAlone: false });
  });

  test("a shell at its prompt is a shell to both, and has the terminal alone", async () => {
    const rpc = herdr({ pane_id: "w1:p3", agent: null, agent_status: "unknown" });
    expect(await promptTarget(rpc, "w1:p3", undefined)).toEqual({ paneId: "w1:p3", isAgent: false, status: null, shellAlone: true });
  });

  // B4, re-verified: in the 215–285ms before herdr names the agent it has
  // started, the agent already has the terminal and its trust menu drawn.
  test("a program holding the terminal before herdr names it an agent is not the shell alone", async () => {
    const rpc = herdr({ pane_id: "w1:p3", agent: null, agent_status: "unknown" }, claudeRunning);
    expect(await promptTarget(rpc, "w1:p3", undefined)).toMatchObject({ isAgent: false, shellAlone: false });
  });

  // Measured 20ms after Enter: the group is still the shell's, with the
  // child it forked for the command in it.
  test("a child the shell has forked, still in the shell's group, is not the shell alone", async () => {
    const forked = { ...atPrompt, foreground_processes: [{ pid: 101, name: "zsh" }, { pid: 100, name: "zsh" }] };
    const rpc = herdr({ pane_id: "w1:p3", agent: null, agent_status: "unknown" }, forked);
    expect(await promptTarget(rpc, "w1:p3", undefined)).toMatchObject({ shellAlone: false });
  });

  test("a pane herdr cannot say the terminal of is left to its screen", async () => {
    const rpc = herdr({ pane_id: "w1:p3", agent: null, agent_status: "unknown" }, new Error("herdr pane.process_info timed out"));
    expect(await promptTarget(rpc, "w1:p3", undefined)).toMatchObject({ shellAlone: false });
    const noShell = herdr({ pane_id: "w1:p3", agent: null }, { shell_pid: null, foreground_process_group_id: null, foreground_processes: [] });
    expect(await promptTarget(noShell, "w1:p3", undefined)).toMatchObject({ shellAlone: false });
  });

  test("the mirror answers when herdr cannot", async () => {
    const rpc = herdr(new Error("herdr pane.get timed out"));
    expect(await promptTarget(rpc, "w1:p2", { agent_status: "idle" })).toEqual({ paneId: "w1:p2", isAgent: true, status: "idle", shellAlone: false });
  });
});
