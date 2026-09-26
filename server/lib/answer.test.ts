import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerPrompt, keysFor, PromptChanged, PromptGone } from "./answer";
import { PaneWrites } from "./pane-writes";
import { PromptInstances, screenId } from "./prompt-instances";
import { parsePrompt } from "./prompt-parser";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

/**
 * A herdr whose pane shows `screen`, recording what is pressed. Once a key
 * lands the agent draws `next` (by default, no question at all), `paintMs`
 * later.
 */
function fakeHerdr(screen: string, { next = "", paintMs = 0 } = {}) {
  const pressed: string[][] = [];
  const pane = { screen };
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "pane.read") return { read: { text: pane.screen } };
    if (method === "pane.send_keys") {
      pressed.push(params.keys as string[]);
      if (paintMs > 0) setTimeout(() => { pane.screen = next; }, paintMs);
      else pane.screen = next;
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, pressed, pane };
}

describe("keysFor", () => {
  test("a numbered menu is answered by its digit, wherever the cursor is", () => {
    const prompt = parsePrompt(fixture("blocked__w4-p2__text.txt"))!;
    expect(keysFor(prompt, prompt.options[2]!)).toEqual(["3"]);
  });

  test("a numbered codex trust menu selects its digit and confirms with Enter", () => {
    const prompt = parsePrompt(fixture("blocked__codex-trust-folder__text.txt"))!;
    expect(prompt).toMatchObject({ answer: "digit", confirm: true });
    expect(keysFor(prompt, prompt.options[0]!)).toEqual(["1", "Enter"]);
  });

  test("a cursor menu is walked from the lit row, then confirmed", () => {
    // Cursor on the second of two rows: "Yes, I trust this folder".
    const prompt = parsePrompt(fixture("blocked__trust-folder__text.txt"))!;
    expect(prompt.answer).toBe("cursor");
    expect(keysFor(prompt, prompt.options[0]!)).toEqual(["Up", "Enter"]);
    expect(keysFor(prompt, prompt.options[1]!)).toEqual(["Enter"]);
  });

  // Pre-release bug hunt, B10: with the cursor on a text field a digit is
  // typed into the field ("❯ 3. 1"), so the tap chose nothing. Real captures
  // from Claude Code 2.1.282, where `Up` then the digit chose the row.
  describe("a numbered option, while the cursor rests on a text field", () => {
    test.each([
      ["blocked__claude-ask-type__text.txt", 0, ["Up", "1"]],
      ["blocked__claude-ask-typed__text.txt", 1, ["Up", "2"]],
      ["blocked__claude-plan-change__text.txt", 1, ["Up", "2"]],
    ])("is chosen, not typed into the field (%s)", (name, option, keys) => {
      const prompt = parsePrompt(fixture(name))!;
      expect(keysFor(prompt, prompt.options[option]!)).toEqual(keys);
    });

    test("the field itself, already under the cursor, presses nothing", () => {
      const prompt = parsePrompt(fixture("blocked__claude-ask-type__text.txt"))!;
      expect(keysFor(prompt, prompt.options[2]!)).toEqual([]);
    });

    test("a field with text in it but not the cursor leaves the digit as it was", () => {
      const prompt = parsePrompt(fixture("blocked__claude-ask-typed-away__text.txt"))!;
      expect(keysFor(prompt, prompt.options[0]!)).toEqual(["1"]);
    });
  });

  test("moves down as many rows as it takes", () => {
    const prompt = parsePrompt(
      ["Which one?", "", " ❯ One", "   Two", "   Three", "", " Enter to confirm · Esc to cancel"].join("\n"),
    )!;
    expect(keysFor(prompt, prompt.options[2]!)).toEqual(["Down", "Down", "Enter"]);
  });
});

describe("answerPrompt", () => {
  test("re-reads the screen and presses what the fresh parse says", async () => {
    const { rpc, pressed } = fakeHerdr(fixture("blocked__trust-folder__text.txt"));
    await expect(answerPrompt(rpc, "w4:p2", { index: 1, label: "No, exit" })).resolves.toEqual(["Up", "Enter"]);
    expect(pressed).toEqual([["Up", "Enter"]]);
  });

  test("answering Red from a typed text field chooses Red, and nothing is typed into the field", async () => {
    const { rpc, pressed } = fakeHerdr(fixture("blocked__claude-ask-typed__text.txt"));
    await answerPrompt(rpc, "w6:p2", { index: 1, label: "Red" });
    expect(pressed).toEqual([["Up", "1"]]);
  });

  test("presses nothing when the prompt has gone", async () => {
    const { rpc, pressed } = fakeHerdr(fixture("idle__w4-p1__text.txt"));
    await expect(answerPrompt(rpc, "w4:p1", { index: 1, label: "No, exit" })).rejects.toBeInstanceOf(PromptGone);
    expect(pressed).toEqual([]);
  });

  // Every Claude permission menu offers "1. Yes". A card still showing the
  // approval for one command must not approve the next one, which the screen
  // may be asking by the time the tap arrives. Both screens are real captures.
  describe("a card drawn from one permission request", () => {
    const card = parsePrompt(fixture("blocked__claude-bash__text.txt"))!; // touch probe.txt
    const yes = { index: 1, label: "Yes", question: card.question, context: card.context };

    test("cannot approve a different request with the same answers", async () => {
      const { rpc, pressed } = fakeHerdr(fixture("blocked__claude-bash-rm__text.txt")); // rm -rf build dist
      await expect(answerPrompt(rpc, "w1:p1", yes)).rejects.toBeInstanceOf(PromptChanged);
      expect(pressed).toEqual([]);
    });

    test("still answers the request it was drawn from", async () => {
      const { rpc, pressed } = fakeHerdr(fixture("blocked__claude-bash__text.txt"));
      await expect(answerPrompt(rpc, "w1:p1", yes)).resolves.toEqual(["1"]);
      expect(pressed).toEqual([["1"]]);
    });

    test("an older client, which sends only the index and label, is answered as before", async () => {
      const { rpc, pressed } = fakeHerdr(fixture("blocked__claude-bash-rm__text.txt"));
      await expect(answerPrompt(rpc, "w1:p1", { index: 1, label: "Yes" })).resolves.toEqual(["1"]);
      expect(pressed).toEqual([["1"]]);
    });

    test("a question with no context matches a card that showed none", async () => {
      const screen = fixture("blocked__w4-p2__text.txt");
      const plan = parsePrompt(screen)!;
      expect(plan.context).toBeUndefined();
      const { rpc, pressed } = fakeHerdr(screen);
      await answerPrompt(rpc, "w4:p2", { index: 2, label: "Yes, manually approve edits", question: plan.question });
      expect(pressed).toEqual([["2"]]);
    });
  });

  test("presses nothing when the option under that number is a different one", async () => {
    // The phone tapped "1. Yes, and bypass permissions" from a stale card; the
    // screen now asks something else whose first option reads differently.
    const { rpc, pressed } = fakeHerdr(fixture("blocked__wK-p2__text.txt"));
    await expect(
      answerPrompt(rpc, "wK:p2", { index: 1, label: "Yes, and bypass permissions" }),
    ).rejects.toBeInstanceOf(PromptChanged);
    expect(pressed).toEqual([]);
  });
});

/**
 * Pre-release bug hunt, B5: two phones answering one prompt within the
 * agent's repaint time both read it still on screen and both pressed "1"; the
 * second approved the next prompt, which neither had shown. 29 of 40 trials
 * doubled against an agent that repaints 32ms after input. The route runs
 * answers through the pane's queue (`PaneWrites`), and an answer holds it
 * until the screen has moved on.
 */
describe("two phones answering one prompt", () => {
  const BASH = fixture("blocked__claude-bash__text.txt"); // touch probe.txt
  // The next permission, queued behind the first: the same question and "1. Yes".
  const NEXT = BASH.replace("   touch probe.txt", "   touch probe-2.txt");
  const card = parsePrompt(BASH)!;

  async function bothAnswer(rpc: Parameters<typeof answerPrompt>[0], choice: Parameters<typeof answerPrompt>[2], options = {}) {
    const writes = new PaneWrites();
    const instances = new PromptInstances();
    const answer = () => writes.run("w1:p1", () => answerPrompt(rpc, "w1:p1", choice, { instances, ...options }));
    return Promise.allSettled([answer(), answer()]);
  }

  test.each([0, 32])("press one key between them when the agent repaints %ims after it", async (paintMs) => {
    expect(NEXT).not.toBe(BASH);
    const { rpc, pressed } = fakeHerdr(BASH, { next: NEXT, paintMs });
    const [first, second] = await bothAnswer(rpc, { index: 1, label: "Yes", question: card.question, context: card.context });
    expect(pressed).toEqual([["1"]]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && second.reason).toBeInstanceOf(PromptChanged);
  });

  // An agent slower to repaint than the answer waits: what it asked has been
  // answered, whatever it has yet to draw.
  test("the second is refused as already answered when the agent has not repainted at all", async () => {
    const { rpc, pressed } = fakeHerdr(BASH, { next: BASH });
    const [first, second] = await bothAnswer(rpc, { index: 1, label: "Yes" }, { sleep: async () => {}, settleMs: 100 });
    expect(pressed).toEqual([["1"]]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && second.reason).toBeInstanceOf(PromptGone);
    expect(second.status === "rejected" && (second.reason as Error).message).toContain("already been answered");
  });

  // Only a screen that moves on is waited for; a digit that just puts the
  // cursor in a text field leaves the question open for the text.
  test("an answer holds the pane only until the screen changes", async () => {
    const { rpc } = fakeHerdr(BASH, { next: NEXT });
    const slept: number[] = [];
    await answerPrompt(rpc, "w1:p1", { index: 1, label: "Yes" }, { sleep: async (ms) => void slept.push(ms) });
    expect(slept).toHaveLength(1);
  });
});

/**
 * Pre-release bug hunt, B46: an agent asking for the same command a second
 * time draws a byte-identical card, so a phone still showing the first
 * approved the second, which it had never shown. Each appearance now has an
 * id, and a card carries the one it was drawn from.
 */
describe("a card drawn before the agent asked the same question again", () => {
  const BASH = fixture("blocked__claude-bash__text.txt");
  const card = parsePrompt(BASH)!;
  const WORKING = "✻ Working… (2s · esc to interrupt)";
  /** What the poller would have sent the phones: the prompt on screen, with its id. */
  function drawn(instances: PromptInstances, text: string) {
    const id = instances.observe("w1:p1", instances.ticket("w1:p1"), parsePrompt(text), screenId(text));
    return { index: 1, label: "Yes", question: card.question, context: card.context, promptId: id! };
  }

  test("cannot approve it, and a card drawn from it can", async () => {
    const instances = new PromptInstances();
    const { rpc, pressed, pane } = fakeHerdr(BASH, { next: WORKING });
    const phoneA = drawn(instances, BASH);
    const phoneB = { ...phoneA };
    await answerPrompt(rpc, "w1:p1", phoneA, { instances });
    expect(pane.screen).toBe(WORKING);

    // The agent works, then asks for the same command again.
    pane.screen = BASH;
    await expect(answerPrompt(rpc, "w1:p1", phoneB, { instances })).rejects.toBeInstanceOf(PromptGone);
    expect(pressed).toEqual([["1"]]);

    const redrawn = drawn(instances, BASH);
    expect(redrawn.promptId).not.toBe(phoneA.promptId);
    await answerPrompt(rpc, "w1:p1", redrawn, { instances });
    expect(pressed).toEqual([["1"], ["1"]]);
  });

  test("a card with no id, from a server or client before ids, is held to its content as before", async () => {
    const instances = new PromptInstances();
    const { rpc, pressed } = fakeHerdr(BASH, { next: WORKING });
    drawn(instances, BASH);
    await answerPrompt(rpc, "w1:p1", { index: 1, label: "Yes", question: card.question, context: card.context }, { instances });
    expect(pressed).toEqual([["1"]]);
  });

  test("the poller's read racing the answer's does not refuse a current card", async () => {
    const instances = new PromptInstances();
    const phone = drawn(instances, BASH);
    let reads = 0;
    const { rpc: plain, pressed } = fakeHerdr(BASH, { next: WORKING });
    // The poller's read of the same screen is sent after the answer's and
    // lands first.
    const rpc = async (method: string, params: Record<string, unknown>) => {
      if (method === "pane.read" && reads++ === 0) drawn(instances, BASH);
      return plain(method, params);
    };
    await answerPrompt(rpc, "w1:p1", phone, { instances });
    expect(pressed).toEqual([["1"]]);
  });
});
