import { describe, expect, test } from "bun:test";
import { QUICK_REPLIES, waitingForReply, type ReplyMoment } from "./quick-replies";

const waiting: ReplyMoment = { isAgent: true, status: "idle", prompt: false, working: false, drafted: false, sending: false, canWrite: true };

describe("quick replies are offered only while the agent waits for the next message", () => {
  test("an idle or finished agent with nothing typed is waiting", () => {
    expect(waitingForReply(waiting)).toBe(true);
    expect(waitingForReply({ ...waiting, status: "done" })).toBe(true);
  });

  test("a working, blocked or unknown agent is not", () => {
    for (const status of ["working", "blocked", "unknown", undefined] as const) expect(waitingForReply({ ...waiting, status })).toBe(false);
  });

  test("an open prompt card is answered by the card, not by a reply", () => {
    expect(waitingForReply({ ...waiting, prompt: true })).toBe(false);
  });

  test("a status line still working, or a send awaiting its reply, is not waiting", () => {
    expect(waitingForReply({ ...waiting, working: true })).toBe(false);
    expect(waitingForReply({ ...waiting, sending: true })).toBe(false);
  });

  test("a plain shell is never offered a reply", () => {
    expect(waitingForReply({ ...waiting, isAgent: false })).toBe(false);
  });

  test("a typed draft hides the chips, so a tap can never replace or discard it", () => {
    expect(waitingForReply({ ...waiting, drafted: true })).toBe(false);
  });

  test("offline, nothing is offered that could not be sent", () => {
    expect(waitingForReply({ ...waiting, canWrite: false })).toBe(false);
  });
});

test("the replies are short, distinct and worded as typed", () => {
  expect(QUICK_REPLIES.length).toBeGreaterThanOrEqual(3);
  expect(QUICK_REPLIES.length).toBeLessThanOrEqual(4);
  expect(new Set(QUICK_REPLIES).size).toBe(QUICK_REPLIES.length);
  for (const reply of QUICK_REPLIES) {
    expect(reply.length).toBeLessThanOrEqual(30);
    expect(reply).not.toMatch(/^\/|\n/);
  }
});
