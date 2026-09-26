import { expect, test } from "bun:test";
import type { DashboardPane, ParsedPrompt } from "./index";
import { answerRefused, promptAnswered, promptIdentity, promptPushed, promptsFromSession, type PromptState } from "./prompts";

const ask = (question: string, labels = ["Yes", "No"]): ParsedPrompt => ({
  question, answer: "digit", options: labels.map((label, i) => ({ index: i + 1, label, selected: i === 0 })),
});
const A = ask("Run the migration?");
const B = ask("Delete the old table?");
const pane = (status: DashboardPane["status"], prompt: ParsedPrompt | null | undefined): Pick<DashboardPane, "paneId" | "status" | "prompt"> =>
  ({ paneId: "w1:p1", status, prompt: prompt as ParsedPrompt | null });
const empty: PromptState = { prompts: {}, answered: {} };

// A phone slept through question B while A was answered at the laptop. The
// server's snapshot said B; the card kept A, whose every tap was refused.
test("a waiting card follows the snapshot's question, not one remembered from before a disconnect", () => {
  const remembered = promptPushed(empty, "w1:p1", A);
  expect(promptsFromSession([pane("blocked", B)], remembered).prompts["w1:p1"]).toEqual(B);
});

test("a pane still waiting whose screen shows no menu offers no options", () => {
  const remembered = promptPushed(empty, "w1:p1", A);
  expect(promptsFromSession([pane("blocked", null)], remembered).prompts).toEqual({});
});

test("a server whose snapshot carries no prompt at all keeps the one it pushed", () => {
  const remembered = promptPushed(empty, "w1:p1", A);
  expect(promptsFromSession([pane("blocked", undefined)], remembered).prompts["w1:p1"]).toEqual(A);
});

// The snapshot after an answer usually still says blocked, with the answered
// question on it; that brought its options back, enabled.
test("an answered question is not offered again while the pane still waits", () => {
  const answered = promptAnswered(promptPushed(empty, "w1:p1", A), "w1:p1", A, "sent");
  const next = promptsFromSession([pane("blocked", A)], answered);
  expect(next.prompts).toEqual({});
  expect(next.answered["w1:p1"]?.outcome).toBe("sent");
  expect(promptPushed(next, "w1:p1", A)).toBe(next);
});

test("the next question after an answer is offered, and the pane moving on forgets the answer", () => {
  const answered = promptAnswered(promptPushed(empty, "w1:p1", A), "w1:p1", A, "sent");
  const asked = promptsFromSession([pane("blocked", B)], answered);
  expect(asked.prompts["w1:p1"]).toEqual(B);
  expect(asked.answered).toEqual({});
  const pushed = promptPushed(answered, "w1:p1", B);
  expect(pushed.prompts["w1:p1"]).toEqual(B);
  expect(pushed.answered).toEqual({});
  expect(promptsFromSession([pane("working", null)], answered)).toEqual(empty);
});

test("a watched pane's frame without a prompt stops the card offering one", () => {
  expect(promptPushed(promptPushed(empty, "w1:p1", A), "w1:p1", null).prompts).toEqual({});
});

test("a question that closed before the answer arrived is not offered again, and says so", () => {
  const closed = promptAnswered(promptPushed(empty, "w1:p1", A), "w1:p1", A, "closed");
  expect(closed.prompts).toEqual({});
  expect(promptsFromSession([pane("blocked", null)], closed).answered["w1:p1"]).toEqual({ identity: promptIdentity(A), outcome: "closed" });
});

test("only the codes that mean nothing was pressed count as a closed question", () => {
  expect(answerRefused({ code: "prompt_gone" })).toBe(true);
  expect(answerRefused({ code: "prompt_changed" })).toBe(true);
  expect(answerRefused(new Error("timed out"))).toBe(false);
  expect(answerRefused(null)).toBe(false);
});

test("an identical question asked again has a new identity even without an intervening frame", () => {
  const first = { ...A, promptId: "first" };
  const repeated = { ...A, promptId: "second" };
  const answered = promptAnswered(promptPushed(empty, "w1:p1", first), "w1:p1", first, "sent");
  expect(promptPushed(answered, "w1:p1", first).prompts).toEqual({});
  expect(promptPushed(answered, "w1:p1", repeated).prompts["w1:p1"]).toEqual(repeated);
  expect(promptsFromSession([pane("blocked", repeated)], answered).answered).toEqual({});
});
