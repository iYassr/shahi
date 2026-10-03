import { describe, expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ParsedPrompt, PromptOption } from "@shahi/shared";
import { answerableOptions, associatedData, fitLines, MAX_SEALED_BYTES, parsePushKey, pushKeyId, seal, sealedContent } from "./push-seal";

/**
 * The same vector `mobile/plugins/notification-service/tests/run.sh` opens
 * with the extension's own Swift: what this seals, the phone opens.
 */
const vector = JSON.parse(readFileSync(new URL("../fixtures/push-seal-vector.json", import.meta.url), "utf8")) as {
  key: string; kid: string; nonce: string; serverId: string; paneId: string; plaintext: string; box: string;
};

/** Opens a box the way the extension does, here with node:crypto. */
function open(box: string, key: string, serverId: string, paneId: string): string {
  const bytes = Buffer.from(box, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), bytes.subarray(0, 12));
  decipher.setAAD(associatedData(serverId, paneId));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
}

describe("the sealed box", () => {
  test("seals the known-answer vector the phone's extension opens", () => {
    expect(seal(vector.key, vector.serverId, vector.paneId, vector.plaintext, Buffer.from(vector.nonce, "base64"))).toBe(vector.box);
    expect(pushKeyId(vector.key)).toBe(vector.kid);
    expect(open(vector.box, vector.key, vector.serverId, vector.paneId)).toBe(vector.plaintext);
  });

  test("a box opens only under the computer and pane it was sealed for", () => {
    const box = seal(vector.key, vector.serverId, vector.paneId, "{}");
    expect(() => open(box, vector.key, vector.serverId, "w1:p3")).toThrow();
    expect(() => open(box, vector.key, "another-computer", vector.paneId)).toThrow();
  });

  test("every message gets a fresh nonce", () => {
    const boxes = new Set(Array.from({ length: 50 }, () => seal(vector.key, vector.serverId, vector.paneId, "same words")));
    expect(boxes.size).toBe(50);
    const nonces = new Set([...boxes].map((box) => Buffer.from(box, "base64").subarray(0, 12).toString("hex")));
    expect(nonces.size).toBe(50);
  });

  test("a push key is exactly 32 bytes of base64, and anything else is refused", () => {
    expect(parsePushKey(vector.key)).toBe(vector.key);
    expect(parsePushKey(Buffer.alloc(16).toString("base64"))).toBeNull();
    expect(parsePushKey(Buffer.alloc(33).toString("base64"))).toBeNull();
    expect(parsePushKey(vector.key.replace(/=$/, ""))).toBeNull();
    expect(parsePushKey("not a key at all, but it is long enough to be one!!")).toBeNull();
    expect(parsePushKey(42)).toBeNull();
    expect(parsePushKey("A".repeat(10_000))).toBeNull();
  });
});

const option = (index: number, label: string, over: Partial<PromptOption> = {}): PromptOption => ({ index, label, selected: index === 1, ...over });

/** Claude Code's Bash card, as `prompt-parser.test.ts` reads it from its fixture. */
const bash: ParsedPrompt = {
  question: "Do you want to proceed?",
  answer: "digit",
  context: ['Bash command\nTip: auto mode handles these prompts for you — choose "switch to auto mode" below', "python3 tip.py\nRun the tip calculator"],
  options: [
    option(1, "Yes"),
    option(2, "Yes, and always allow access to /private/tmp/shahi-p15.GlMGfu/proj from this project"),
    option(3, "Yes, and switch to auto mode · auto mode handles these prompts for you"),
    option(4, "No"),
  ],
  promptId: "0b4e7c1e-6a51-4c57-9a52-1f7b0f4f8e21",
};

describe("what a sealed notification says", () => {
  test("the question and its command, under the space and the conversation", () => {
    const content = sealedContent({ workspaceLabel: "tips", conversation: "Claude", prompt: bash, instanceId: "term_a" });
    expect(content.title).toBe("tips needs you");
    expect(content.subtitle).toBe("Claude");
    expect(content.body.split("\n")).toEqual(["Do you want to proceed?", "Bash command", expect.stringContaining("Tip: auto mode"), "python3 tip.py", "Run the tip calculator"]);
    expect(content.instanceId).toBe("term_a");
  });

  // The answer is compared with a fresh read of the screen by `/answer`; a
  // label cleaned for the button would never match.
  test("an action posts the parser's own label and shows the card's", () => {
    const options = [option(1, "Yes, proceed (y)"), option(2, "No, and tell Codex what to do differently (esc)")];
    const content = sealedContent({ workspaceLabel: "w", conversation: "Codex", prompt: { ...bash, options } });
    expect(content.answer?.options).toEqual([
      { index: 1, label: "Yes, proceed (y)", title: "Yes, proceed" },
      { index: 2, label: "No, and tell Codex what to do differently (esc)", title: "No, and tell Codex what to do differently" },
    ]);
    expect(content.answer).toMatchObject({ promptId: bash.promptId, question: bash.question, context: bash.context });
  });

  test("past three answers the buttons are the first two and the refusal, and never a text field", () => {
    expect(answerableOptions(bash.options).map((o) => o.label)).toEqual(["Yes", bash.options[1]!.label, "No"]);
    const question = [option(1, "Red"), option(2, "Blue"), option(3, "Type something.", { textInput: true }), option(4, "Chat about this")];
    expect(answerableOptions(question).map((o) => o.label)).toEqual(["Red", "Blue", "Chat about this"]);
    expect(answerableOptions([option(1, "Tell Claude what to change", { textInput: true })])).toEqual([]);
  });

  test("a prompt without an id offers no buttons: nothing would say which appearance was answered", () => {
    const { promptId: _, ...anonymous } = bash;
    expect(sealedContent({ workspaceLabel: "w", conversation: "c", prompt: anonymous }).answer).toBeUndefined();
  });

  test("a pane waiting on nothing the parser knows is named, with no buttons", () => {
    expect(sealedContent({ workspaceLabel: "api", conversation: "Refactor billing", prompt: null })).toEqual({ title: "api needs you", body: "Refactor billing" });
  });

  // An edit's diff can be thousands of lines. What cannot fit is dropped,
  // never cut: the question and context first, which the prompt id already
  // stands for, then the buttons; the words to read are cut instead.
  test("a huge diff fits: the words are cut, the answer keeps exact labels or goes", () => {
    const diff = Array.from({ length: 4_000 }, (_, i) => `+ line ${i} 👩🏽‍💻 ${"x".repeat(60)}`).join("\n");
    const prompt: ParsedPrompt = { ...bash, question: "Do you want to make this edit to tip.py?", context: ["Edit file", diff] };
    const content = sealedContent({ workspaceLabel: "👩🏽‍💻".repeat(400), conversation: "ش".repeat(2_000), prompt });
    expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeLessThanOrEqual(MAX_SEALED_BYTES);
    expect(content.body.startsWith("Do you want to make this edit to tip.py?\nEdit file\n+ line 0")).toBe(true);
    expect(content.answer?.promptId).toBe(bash.promptId);
    expect(content.answer?.question).toBeUndefined();
    expect(content.answer?.context).toBeUndefined();
    // A button's title is cut to fit on one line; the label it posts is not.
    expect(content.answer?.options.map((o) => o.label)).toEqual(["Yes", bash.options[1]!.label, "No"]);
    expect(content.answer?.options[1]!.title).toEndWith("…");

    const enormous = [option(1, "Yes ".repeat(400)), option(2, "No ".repeat(400))];
    const bare = sealedContent({ workspaceLabel: "w", conversation: "c", prompt: { ...prompt, options: enormous } });
    expect(bare.answer).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(bare)).length).toBeLessThanOrEqual(MAX_SEALED_BYTES);
  });

  test("lines are cut between graphemes and keep their breaks", () => {
    const text = fitLines(["first line", "👩🏽‍💻".repeat(50)], 60);
    expect(text.startsWith("first line\n")).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(60);
    const kept = text.split("\n")[1]!.replace(/…$/, "");
    expect(kept.length % "👩🏽‍💻".length).toBe(0);
  });
});
