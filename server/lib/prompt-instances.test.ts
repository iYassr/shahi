import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PromptInstances, screenId } from "./prompt-instances";
import { parsePrompt } from "./prompt-parser";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");

/** One read of `text` on `pane`, observed as the poller and the answer route observe theirs. */
function see(instances: PromptInstances, text: string, pane = "w1:p1") {
  const ticket = instances.ticket(pane);
  return instances.observe(pane, ticket, parsePrompt(text), screenId(text));
}

const BASH = fixture("blocked__claude-bash__text.txt"); // touch probe.txt
const WORKING = "✻ Working… (3s · esc to interrupt)";

describe("PromptInstances", () => {
  test("a prompt keeps its id while it stays on screen, the cursor moving included", () => {
    const instances = new PromptInstances();
    const id = see(instances, BASH);
    expect(id).toBeString();
    expect(see(instances, BASH)).toBe(id);
    const moved = BASH.replace("❯ 1. Yes", "  1. Yes").replace("  2. Yes", "❯ 2. Yes");
    expect(moved).not.toBe(BASH);
    expect(see(instances, moved)).toBe(id);
  });

  test("a different question is a different prompt", () => {
    const instances = new PromptInstances();
    const first = see(instances, BASH);
    expect(see(instances, fixture("blocked__claude-bash-rm__text.txt"))).not.toBe(first);
  });

  // Pre-release bug hunt, B46: the same command asked for twice drew the same
  // card, and a phone still showing the first approved the second.
  test("the same question asked again after a screen without it is a new prompt", () => {
    const instances = new PromptInstances();
    const first = see(instances, BASH);
    expect(see(instances, WORKING)).toBeUndefined();
    expect(see(instances, BASH)).not.toBe(first);
  });

  test("once answered, the same question is a new prompt even when no screen in between was seen", () => {
    const instances = new PromptInstances();
    const first = see(instances, BASH);
    instances.answered("w1:p1", screenId(BASH));
    // The answered screen itself carries an id nothing can answer with.
    const onAnswered = see(instances, BASH);
    expect(onAnswered).not.toBe(first);
    const again = BASH.replace("Do you want to proceed?", "Do you want to proceed?\n");
    const next = see(instances, again);
    expect(next).not.toBe(first);
    expect(next).not.toBe(onAnswered);
  });

  // B5: the second of two answers read the screen before the agent had drawn
  // what came next, and pressed its key on the prompt after.
  test("the answered screen is refused until the pane shows another", () => {
    const instances = new PromptInstances();
    see(instances, BASH);
    instances.answered("w1:p1", screenId(BASH));
    expect(instances.alreadyAnswered("w1:p1", screenId(BASH))).toBe(true);
    see(instances, BASH);
    expect(instances.alreadyAnswered("w1:p1", screenId(BASH))).toBe(true);
    see(instances, WORKING);
    expect(instances.alreadyAnswered("w1:p1", screenId(BASH))).toBe(false);
  });

  // The poller and the answer route both read: a slow read that finishes
  // after a later one must not bring back what the later one saw gone.
  test("a read overtaken by a later one changes nothing", () => {
    const instances = new PromptInstances();
    const first = see(instances, BASH);
    const slow = instances.ticket("w1:p1");
    expect(see(instances, WORKING)).toBeUndefined();
    expect(instances.observe("w1:p1", slow, parsePrompt(BASH), screenId(BASH))).toBeUndefined();
    expect(see(instances, BASH)).not.toBe(first);
  });

  test("a read overtaken by one that found the same screen shares its id", () => {
    const instances = new PromptInstances();
    const slow = instances.ticket("w1:p1");
    const id = see(instances, BASH);
    expect(instances.observe("w1:p1", slow, parsePrompt(BASH), screenId(BASH))).toBe(id!);
  });

  test("panes are counted apart, and a forgotten pane starts again", () => {
    const instances = new PromptInstances();
    const one = see(instances, BASH, "w1:p1");
    expect(see(instances, BASH, "w1:p2")).not.toBe(one);
    instances.answered("w1:p1", screenId(BASH));
    expect(instances.alreadyAnswered("w1:p2", screenId(BASH))).toBe(false);
    instances.forget("w1:p1");
    expect(instances.alreadyAnswered("w1:p1", screenId(BASH))).toBe(false);
  });
});
