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

  test("a cursor menu is walked from the lit row, then confirmed", () => {
    // Cursor on the second of two rows: "Yes, I trust this folder".
    const prompt = parsePrompt(fixture("blocked__trust-folder__text.txt"))!;
    expect(prompt.answer).toBe("cursor");
    expect(keysFor(prompt, prompt.options[0]!)).toEqual(["Up", "Enter"]);
    expect(keysFor(prompt, prompt.options[1]!)).toEqual(["Enter"]);
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

  test("presses nothing when the prompt has gone", async () => {
    const { rpc, pressed } = fakeHerdr(fixture("idle__w4-p1__text.txt"));
    await expect(answerPrompt(rpc, "w4:p1", { index: 1, label: "No, exit" })).rejects.toBeInstanceOf(PromptGone);
    expect(pressed).toEqual([]);
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
