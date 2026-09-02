import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { normaliseCodex, rolloutWithinSessions } from "./codex-log";

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

  // The trap, still shut. `response_item` message/reasoning records carry
  // developer-role system prompts plus an <environment_context> block delivered
  // as a user turn. Reading them would put codex's own instructions in the
  // user's mouth — the same mistake as attributing Claude's tool results to
  // them. Tool-call subtypes are the deliberate exception, covered below.
  test("ignores the message and reasoning response_item subtypes", () => {
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
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      event("user_message", "the real question"),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "text", text: "the real question" });
  });

  // Tool activity lives only in response_item and nowhere in event_msg, so
  // dropping it made codex read as if the agent talked but never ran anything.
  // These two records are a verbatim capture from a live codex 2026.07.18.1
  // rollout: the `exec` tool wraps the command in a scrap of JS, and its output
  // arrives as a list of input_text parts under a matching call_id.
  test("renders a custom_tool_call as a tool block, paired to its output", () => {
    const messages = normaliseCodex([
      event("user_message", "count the lines in note.txt"),
      {
        timestamp: "2026-08-09T21:34:24.281Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call_s301jtW9F2ANQ2UhIkAQacy2",
          name: "exec",
          input:
            'const r = await tools.exec_command({"cmd":"wc -l note.txt","workdir":"/home/yasserdo/reader-test"});\ntext(r.output);\n',
        },
      },
      {
        timestamp: "2026-08-09T21:34:27.684Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_s301jtW9F2ANQ2UhIkAQacy2",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
            { type: "input_text", text: "1 note.txt\n" },
          ],
        },
      },
      event("agent_message", "note.txt has 1 line."),
    ]);

    // you → tool → agent, in file order.
    expect(messages.map((m) => m.role)).toEqual(["you", "agent", "agent"]);
    const tool = messages[1]!.blocks[0]!;
    expect(tool).toMatchObject({
      kind: "tool",
      name: "exec",
      summary: "wc -l note.txt",
      result: { text: "Script completed\nWall time 0.2 seconds\nOutput:\n1 note.txt", isError: false },
    });
  });

  // function_call is the other tool shape: a JSON `arguments` string, and its
  // output can be a plain string rather than a list.
  test("renders a function_call, pulling the command out of JSON arguments", () => {
    const [message] = normaliseCodex([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call_x",
          name: "shell",
          arguments: '{"command":"ls -la"}',
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_x", output: "total 0\n" },
      },
    ]);
    expect(message!.blocks[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      summary: "ls -la",
      result: { text: "total 0", truncated: false },
    });
  });

  // A call whose output has not arrived yet renders with a null result — the
  // pending state the client already draws for Claude's unfinished tools.
  test("a tool call with no output yet has a null result", () => {
    const [message] = normaliseCodex([
      { type: "response_item", payload: { type: "function_call", call_id: "pending", name: "shell", arguments: "{}" } },
    ]);
    expect(message!.blocks[0]).toMatchObject({ kind: "tool", name: "shell", result: null });
  });

  // Reasoning is plaintext only in the agent_reasoning event_msg; the matching
  // response_item is encrypted. It was dropped for months (335 events across
  // the real rollouts) — the phone showed an agent that thought silently.
  test("renders agent_reasoning as a thinking block", () => {
    const [message] = normaliseCodex([
      { type: "event_msg", timestamp: "2026-07-25T04:51:48.000Z", payload: { type: "agent_reasoning", text: "**Planning the edit**\n\nI should read the file first." } },
    ]);
    expect(message).toMatchObject({ role: "agent", blocks: [{ kind: "thinking", text: "**Planning the edit**\n\nI should read the file first." }] });
  });

  // codex streams reasoning as a run of small events; the reader joins a run
  // into one block so the view is not a stack of one-line headers.
  test("coalesces a run of reasoning events into one thinking block", () => {
    const messages = normaliseCodex([
      { type: "event_msg", payload: { type: "agent_reasoning", text: "First thought." } },
      { type: "event_msg", payload: { type: "agent_reasoning_raw_content", text: "Second thought." } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "Third thought." } },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks).toEqual([{ kind: "thinking", text: "First thought.\n\nSecond thought.\n\nThird thought." }]);
  });

  // A message between two reasoning events breaks the run, so the second one
  // starts a fresh block rather than joining across the reply.
  test("does not coalesce reasoning across an agent message", () => {
    const messages = normaliseCodex([
      { type: "event_msg", payload: { type: "agent_reasoning", text: "Before." } },
      { type: "event_msg", payload: { type: "agent_message", message: "Here is the answer." } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "After." } },
    ]);
    expect(messages.map((m) => m.blocks[0])).toEqual([
      { kind: "thinking", text: "Before." },
      { kind: "text", text: "Here is the answer." },
      { kind: "thinking", text: "After." },
    ]);
  });

  test("skips a reasoning event with no text", () => {
    expect(normaliseCodex([{ type: "event_msg", payload: { type: "agent_reasoning", text: "   " } }])).toEqual([]);
  });

  // MCP activity lives only in event_msg (334 mcp_tool_call_end dropped before).
  // The _end event names the server and tool and carries the {Ok}/{Err} result.
  test("renders an mcp_tool_call_end as a tool block with its result", () => {
    const [message] = normaliseCodex([
      {
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          invocation: { server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" } },
          result: { Ok: { content: [{ type: "text", text: "navigated to https://example.com" }] } },
        },
      },
    ]);
    expect(message).toMatchObject({
      role: "agent",
      blocks: [{ kind: "tool", name: "playwright.browser_navigate", summary: "https://example.com", result: { text: "navigated to https://example.com", isError: false } }],
    });
  });

  test("marks an mcp Err result as an error", () => {
    const [message] = normaliseCodex([
      { type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "db", tool: "query", arguments: { title: "count rows" } }, result: { Err: "connection refused" } } },
    ]);
    expect(message!.blocks[0]).toMatchObject({ kind: "tool", name: "db.query", summary: "count rows", result: { text: "connection refused", isError: true } });
  });

  // apply_patch via codex's native tool is recorded only as patch_apply_end,
  // never as a response_item — dropping it hid every native file edit.
  test("renders patch_apply_end as an apply_patch tool block", () => {
    const [message] = normaliseCodex([
      {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "exec-1",
          stdout: "Success. Updated the following files:\nM src/app.ts\n",
          stderr: "",
          success: true,
          changes: { "/repo/src/app.ts": { type: "update", content: "…" }, "/repo/old.ts": { type: "delete", content: "…" } },
        },
      },
    ]);
    expect(message).toMatchObject({
      role: "agent",
      blocks: [{ kind: "tool", name: "apply_patch", summary: "update app.ts, delete old.ts", result: { isError: false } }],
    });
    expect((message!.blocks[0] as { result: { text: string } }).result.text).toContain("Success");
  });

  test("marks a failed patch_apply_end as an error", () => {
    const [message] = normaliseCodex([
      { type: "event_msg", payload: { type: "patch_apply_end", success: false, stderr: "patch does not apply", changes: {} } },
    ]);
    expect(message!.blocks[0]).toMatchObject({ kind: "tool", name: "apply_patch", result: { text: "patch does not apply", isError: true } });
  });

  // web_search_end also lives only in event_msg; its query is the summary and
  // there is no result payload to render.
  test("renders web_search_end as a web_search tool block", () => {
    const [message] = normaliseCodex([
      { type: "event_msg", payload: { type: "web_search_end", query: "cloudflare durable object limits" } },
    ]);
    expect(message).toMatchObject({ role: "agent", blocks: [{ kind: "tool", name: "web_search", summary: "cloudflare durable object limits", result: null }] });
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

/**
 * The session-id route, which only exists once herdr's codex integration is
 * installed. `CODEX_HOME` is read when the module loads, so this imports a
 * fresh copy pointed at a temp directory rather than at the real one.
 */
describe("findCodexRollout, by session id", () => {
  const home = mkdtempSync(join(tmpdir(), "shahi-codex-"));
  const id = "019f9bd1-1b6b-7f33-a046-a60cce4e6455";
  const rollout = join(home, "sessions/2026/07/26", `rollout-2026-07-26T00-26-40-${id}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, "");

  // A client that would throw if the process route were reached, so a passing
  // test proves the id answered rather than something else finding it anyway.
  const noClient = {
    rpc: () => {
      throw new Error("the session id should have answered before /proc was asked");
    },
  } as never;

  const load = async () => {
    process.env.CODEX_HOME = home;
    return (await import(`./codex-log?codex-home=${encodeURIComponent(home)}`)) as typeof import("./codex-log");
  };

  test("finds the rollout the id names, with no index and no process", async () => {
    const { findCodexRollout } = await load();
    expect(await findCodexRollout(noClient, "w1:p1", null, id)).toBe(rollout);
  });

  // Ids arrive from another process via herdr. A path fragment in one must not
  // become a path.
  test("refuses anything that is not a plain uuid", async () => {
    const { findCodexRollout } = await load();
    for (const bad of ["../../etc/passwd", `${id}/..`, "", "*"]) {
      expect(await findCodexRollout(noClient, "w1:p1", null, bad)).toBe(null);
    }
  });
});

describe("rolloutWithinSessions", () => {
  // The thread index is a file codex writes and the session id is reported
  // by the agent process, so a `rollout_path` from either is not this
  // server's to trust: only a rollout under the sessions directory is read.
  const sessions = "/home/me/.codex/sessions";

  test("accepts a rollout under the sessions directory", () => {
    const path = `${sessions}/2026/07/25/rollout-2026-07-25T04-51-48-abc.jsonl`;
    expect(rolloutWithinSessions(path, sessions)).toBe(path);
  });

  test("refuses anything outside it, however it is spelled", () => {
    expect(rolloutWithinSessions("/etc/passwd", sessions)).toBeNull();
    expect(rolloutWithinSessions("/home/me/.ssh/id_ed25519.jsonl", sessions)).toBeNull();
    expect(rolloutWithinSessions(`${sessions}/../../.ssh/id_ed25519.jsonl`, sessions)).toBeNull();
    expect(rolloutWithinSessions(`${sessions}-other/x.jsonl`, sessions)).toBeNull();
    expect(rolloutWithinSessions(`${sessions}/notes.txt`, sessions)).toBeNull();
    expect(rolloutWithinSessions(undefined, sessions)).toBeNull();
    expect(rolloutWithinSessions(42, sessions)).toBeNull();
  });
});

// codex canonicalises CODEX_HOME, so with a symlinked home its index holds real
// paths while a bare join of our own would be the link; both spellings must
// resolve to the same file or every indexed rollout is refused.
test("rolloutWithinSessions follows a symlinked sessions directory", () => {
  const root = mkdtempSync(join(tmpdir(), "shahi-codex-"));
  const real = join(root, "real", "sessions");
  mkdirSync(join(real, "2026"), { recursive: true });
  writeFileSync(join(real, "2026", "rollout-x.jsonl"), "");
  symlinkSync(join(root, "real"), join(root, "link"));
  const viaLink = join(root, "link", "sessions", "2026", "rollout-x.jsonl");
  const resolved = join(realpathSync(real), "2026", "rollout-x.jsonl");
  expect(rolloutWithinSessions(viaLink, join(root, "link", "sessions"))).toBe(viaLink);
  expect(rolloutWithinSessions(resolved, join(root, "link", "sessions"))).toBe(resolved);
  expect(rolloutWithinSessions(join(root, "real", "sessions", "..", "..", "etc.jsonl"), real)).toBeNull();
});
