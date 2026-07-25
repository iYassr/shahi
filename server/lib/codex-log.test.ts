import { describe, expect, test } from "bun:test";
import { normaliseCodex } from "./codex-log";

const event = (type: string, message?: string, timestamp = "2026-07-25T04:51:48.000Z") => ({
  timestamp,
  type: "event_msg",
  payload: message === undefined ? { type } : { type, message },
});

describe("normaliseCodex", () => {
  test("reads the conversation out of event_msg records", () => {
    const messages = normaliseCodex([
      event("task_started"),
      event("user_message", "test"),
      event("agent_message", "Ready. What would you like to test?"),
      event("token_count"),
      event("task_complete"),
    ]);

    expect(messages.map((m) => [m.role, m.blocks[0]])).toEqual([
      ["you", { kind: "text", text: "test" }],
      ["agent", { kind: "text", text: "Ready. What would you like to test?" }],
    ]);
  });

  // The trap. `response_item` is the raw API conversation and carries
  // developer-role system prompts plus an <environment_context> block delivered
  // as a user turn. Reading it would put codex's own instructions in the user's
  // mouth — the same mistake as attributing Claude's tool results to them.
  test("ignores response_item entirely", () => {
    const messages = normaliseCodex([
      {
        timestamp: "2026-07-25T04:51:48.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>…" }],
        },
      },
      {
        timestamp: "2026-07-25T04:51:49.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context><cwd>/x</cwd>…" }],
        },
      },
      event("user_message", "the real question"),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "text", text: "the real question" });
  });

  test("skips lifecycle events that carry no message", () => {
    expect(normaliseCodex([event("task_started"), event("token_count")])).toEqual([]);
  });

  // codex will add event types; an unknown one must be dropped rather than
  // rendered with a guessed role.
  test("drops event types it does not recognise", () => {
    expect(normaliseCodex([event("some_future_event", "surprising")])).toEqual([]);
  });

  test("ignores session_meta, world_state and turn_context", () => {
    expect(
      normaliseCodex([
        { type: "session_meta", payload: { session_id: "x" } },
        { type: "world_state", payload: {} },
        { type: "turn_context", payload: {} },
      ]),
    ).toEqual([]);
  });

  test("skips an empty or whitespace-only message", () => {
    expect(normaliseCodex([event("user_message", "   "), event("agent_message", "")])).toEqual([]);
  });

  test("carries timestamps through", () => {
    const [message] = normaliseCodex([event("user_message", "hi", "2026-07-25T04:51:48.000Z")]);
    expect(message!.at).toBe(Date.parse("2026-07-25T04:51:48.000Z"));
  });

  test("gives every message a distinct id", () => {
    const messages = normaliseCodex([
      event("user_message", "a"),
      event("agent_message", "b"),
      event("user_message", "c"),
    ]);
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
  });
});
