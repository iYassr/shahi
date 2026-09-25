import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerPrompt, keysFor, PromptChanged, PromptGone } from "./answer";
import { parsePrompt } from "./prompt-parser";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

/** A herdr whose pane shows `screen`, recording what is pressed. */
function fakeHerdr(screen: string) {
  const pressed: string[][] = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "pane.read") return { read: { text: screen } };
    if (method === "pane.send_keys") {
      pressed.push(params.keys as string[]);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, pressed };
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
