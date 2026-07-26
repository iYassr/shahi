import { describe, expect, test } from "bun:test";
import { fileOf, normalise, parseLines, questionsOf, summariseToolInput } from "./session-log";

const assistant = (content: unknown[], over: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid: `a-${Math.random()}`,
  timestamp: "2026-07-25T02:00:00.000Z",
  message: { role: "assistant", content },
  ...over,
});

const user = (content: unknown, over: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: `u-${Math.random()}`,
  timestamp: "2026-07-25T02:00:01.000Z",
  message: { role: "user", content },
  ...over,
});

describe("parseLines", () => {
  test("skips blank lines", () => {
    expect(parseLines('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  // A live session is being appended to as it is read, so the last line is
  // routinely half-written. That must not lose the rest of the transcript.
  test("tolerates a truncated final line", () => {
    expect(parseLines('{"a":1}\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("normalise", () => {
  test("keeps human text as yours and agent text as the agent's", () => {
    const messages = normalise([
      user("what is the plan?"),
      assistant([{ type: "text", text: "Here it is." }]),
    ]);
    expect(messages.map((m) => [m.role, m.blocks[0]])).toEqual([
      ["you", { kind: "text", text: "what is the plan?" }],
      ["agent", { kind: "text", text: "Here it is." }],
    ]);
  });

  // The single most important behaviour here. 1,509 of 1,736 `user` records in
  // real transcripts contain nothing but tool results, because that is how tool
  // output returns through the API. Treating `type: "user"` as "the human said
  // this" attributes almost all tool output to the person.
  test("does not attribute tool results to the human", () => {
    const messages = normalise([
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "a.txt\nb.txt" }]),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("agent");
    expect(messages[0]!.blocks).toEqual([
      {
        kind: "tool",
        name: "Bash",
        summary: "ls -la",
        result: { text: "a.txt\nb.txt", isError: false, truncated: false, images: [] },
      },
    ]);
  });

  test("marks a failed tool result", () => {
    const messages = normalise([
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "nope" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "not found", is_error: true }]),
    ]);
    const block = messages[0]!.blocks[0]!;
    expect(block.kind === "tool" && block.result?.isError).toBe(true);
  });

  test("a tool call with no result yet still renders", () => {
    const messages = normalise([
      assistant([{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/tmp/x" } }]),
    ]);
    const block = messages[0]!.blocks[0]!;
    expect(block.kind === "tool" && block.result).toBeNull();
  });

  describe("tool_result content shapes", () => {
    const resultOf = (content: unknown) => {
      const messages = normalise([
        assistant([{ type: "tool_use", id: "t1", name: "X", input: {} }]),
        user([{ type: "tool_result", tool_use_id: "t1", content }]),
      ]);
      const block = messages[0]!.blocks[0]!;
      return block.kind === "tool" ? block.result?.text : undefined;
    };

    test("plain string", () => expect(resultOf("hello")).toBe("hello"));

    test("list of text parts", () =>
      expect(resultOf([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe(
        "one\ntwo",
      ));

    // Images used to collapse to the literal text "[image]" here, which lost
    // them. They now leave the text and are carried as refs instead — see the
    // "images inside a tool result" block below.
    test("images leave the text rather than becoming a placeholder", () =>
      expect(resultOf([{ type: "text", text: "shot" }, { type: "image", source: {} }])).toBe(
        "shot",
      ));

    test("null content", () => expect(resultOf(null)).toBe(""));
  });

  test("truncates enormous tool output", () => {
    const messages = normalise([
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(9_000) }]),
    ]);
    const block = messages[0]!.blocks[0]!;
    expect(block.kind === "tool" && block.result?.truncated).toBe(true);
    expect(block.kind === "tool" && block.result!.text.length).toBeLessThan(2_100);
  });

  test("keeps thinking as its own block", () => {
    const messages = normalise([
      assistant([
        { type: "thinking", thinking: "weighing options", signature: "sig" },
        { type: "text", text: "Done." },
      ]),
    ]);
    expect(messages[0]!.blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
  });

  test("drops slash-command expansions written for the model", () => {
    expect(normalise([user("expanded instructions", { isMeta: true })])).toEqual([]);
  });

  test("renders a slash command as what was typed", () => {
    const messages = normalise([
      user("<command-name>/review</command-name><command-args>main</command-args>"),
    ]);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "text", text: "/review main" });
  });

  test("unwraps local command output", () => {
    const messages = normalise([user("<local-command-stdout>3 files changed</local-command-stdout>")]);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "text", text: "3 files changed" });
  });

  // Injected context, not something the human wrote.
  test("strips system reminders", () => {
    const messages = normalise([
      user("real question<system-reminder>ignore me</system-reminder>"),
    ]);
    expect(messages[0]!.blocks[0]).toEqual({ kind: "text", text: "real question" });
  });

  test("drops a message that is left empty after stripping", () => {
    expect(normalise([user("<system-reminder>only this</system-reminder>")])).toEqual([]);
  });

  test("ignores record types that are not conversation", () => {
    expect(
      normalise([
        { type: "ai-title", aiTitle: "Some title" },
        { type: "mode", mode: "plan" },
        { type: "file-history-snapshot" },
        assistant([{ type: "text", text: "kept" }]),
      ]),
    ).toHaveLength(1);
  });

  test("carries timestamps through", () => {
    const [message] = normalise([assistant([{ type: "text", text: "hi" }])]);
    expect(message!.at).toBe(Date.parse("2026-07-25T02:00:00.000Z"));
  });
});

describe("summariseToolInput", () => {
  test("prefers the field that says what happened", () => {
    expect(summariseToolInput("Bash", { command: "git status" })).toBe("git status");
    expect(summariseToolInput("Read", { file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
    expect(summariseToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summariseToolInput("Skill", { skill: "brainstorming" })).toBe("brainstorming");
  });

  test("says nothing when there is nothing to say", () => {
    // It used to fall back to the tool's own name, which the client then drew
    // beside the name it was already drawing: "SendUserFile SendUserFile".
    expect(summariseToolInput("Mystery", { weird: 1 })).toBe("");
  });

  test("collapses whitespace and clips long values", () => {
    expect(summariseToolInput("Bash", { command: "echo   a\n  b" })).toBe("echo a b");
    const long = summariseToolInput("Bash", { command: "x".repeat(300) });
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("machine-generated user records", () => {
  const userText = (text: string) =>
    normalise([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-25T02:00:00.000Z",
        message: { role: "user", content: text },
      },
    ]);

  // Same misattribution class as tool results: a background agent reporting in
  // is not the human typing, and rendering it raw shows a wall of XML as "you".
  test("summarises a background task notification", () => {
    const messages = userText(
      [
        "<task-notification>",
        "<task-id>a2ccfc00</task-id>",
        "<tool-use-id>toolu_01L</tool-use-id>",
        "<status>completed</status>",
        '<summary>Agent "Patch unclear gaps" finished</summary>',
        "<result>All 7 gaps fixed</result>",
        "</task-notification>",
      ].join("\n"),
    );
    expect(messages[0]!.blocks[0]).toEqual({
      kind: "text",
      text: 'Agent "Patch unclear gaps" finished (completed)\nAll 7 gaps fixed',
    });
  });

  test("never leaks raw tags into a rendered message", () => {
    const messages = userText("<task-notification><status>done</status></task-notification>");
    const block = messages[0]!.blocks[0]!;
    expect(block.kind === "text" && block.text).not.toContain("<");
  });
});

describe("images inside a tool result", () => {
  // The common case: reading a screenshot returns the image inside the tool
  // result rather than as a block of the message. These were previously
  // collapsed to the literal text "[image]" and lost.
  const withImages = () =>
    normalise([
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x.png" } }], {
        uuid: "a1",
      }),
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-25T02:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "Read image" },
                { type: "image", source: { media_type: "image/png", data: "iVBORw0KGgo=" } },
              ],
            },
          ],
        },
      },
    ]);

  test("keeps a ref instead of dropping the image", () => {
    const block = withImages()[0]!.blocks[0]!;
    expect(block.kind).toBe("tool");
    if (block.kind !== "tool") return;
    expect(block.result?.images).toHaveLength(1);
    expect(block.result?.images[0]).toMatch(/^u1:r0$/);
  });

  test("does not leave a literal [image] in the text", () => {
    const block = withImages()[0]!.blocks[0]!;
    if (block.kind !== "tool") return;
    expect(block.result?.text).not.toContain("[image]");
    expect(block.result?.text).toContain("Read image");
  });
});

describe("fileOf", () => {
  test("finds the file a Read or Write named", () => {
    expect(fileOf({ file_path: "/home/x/project/src/api.ts" })).toEqual({
      file: { path: "/home/x/project/src/api.ts", name: "api.ts" },
    });
  });

  test("covers the notebook and generic spellings", () => {
    expect(fileOf({ notebook_path: "/home/x/a.ipynb" }).file?.name).toBe("a.ipynb");
    expect(fileOf({ path: "/home/x/b.txt" }).file?.name).toBe("b.txt");
  });

  test("ignores a relative path", () => {
    // Unresolvable without knowing where the agent was standing, and offering
    // to open something the server cannot find is worse than offering nothing.
    expect(fileOf({ file_path: "src/api.ts" })).toEqual({});
  });

  test("ignores a call that named no file", () => {
    expect(fileOf({ command: "ls -la" })).toEqual({});
    expect(fileOf({})).toEqual({});
  });
});

describe("questionsOf", () => {
  const input = {
    questions: [
      {
        question: "Which colour?",
        header: "Colour",
        multiSelect: false,
        options: [{ label: "Red", description: "Warm." }, { label: "Green" }],
      },
    ],
  };

  test("keeps the question and every option", () => {
    expect(questionsOf("AskUserQuestion", input)).toEqual({
      questions: [
        {
          text: "Which colour?",
          options: [{ label: "Red", description: "Warm." }, { label: "Green" }],
        },
      ],
    });
  });

  test("keeps all of them when more than one is asked", () => {
    const two = {
      questions: [input.questions[0], { ...input.questions[0], question: "And then?" }],
    };
    expect(questionsOf("AskUserQuestion", two).questions).toHaveLength(2);
  });

  test("ignores every other tool", () => {
    expect(questionsOf("Bash", { command: "ls" })).toEqual({});
    expect(questionsOf("Read", input)).toEqual({});
  });

  test("drops a malformed question rather than rendering an empty card", () => {
    expect(questionsOf("AskUserQuestion", { questions: [{ question: "No options" }] })).toEqual({});
    expect(questionsOf("AskUserQuestion", { questions: "nonsense" })).toEqual({});
    expect(questionsOf("AskUserQuestion", {})).toEqual({});
  });

  test("the summary line becomes the question, not an empty string", () => {
    // What made it invisible: no `command` or `file_path`, so nothing to show.
    expect(summariseToolInput("AskUserQuestion", input)).toBe("Which colour?");
  });
});

