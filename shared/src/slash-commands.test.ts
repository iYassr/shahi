import { describe, expect, test } from "bun:test";
import { builtinCommands, matchCommands, mergeCommands, slashQuery, type SlashCommand } from "./slash-commands";

const command = (name: string, source: SlashCommand["source"] = "builtin", description = name): SlashCommand => ({ name, description, source });

describe("the picker opens on a draft that is one slash-word", () => {
  test("a leading slash opens it, and what follows filters it", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/frontend:comp")).toBe("frontend:comp");
  });

  test("a space, a second line or a slash anywhere but first closes it", () => {
    expect(slashQuery("/compact ")).toBeNull();
    expect(slashQuery("/compact keep the plan")).toBeNull();
    expect(slashQuery("/co\n")).toBeNull();
    expect(slashQuery("see /compact")).toBeNull();
    expect(slashQuery(" /co")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("typing filters the commands", () => {
  const all = builtinCommands("claude");

  test("/co finds compact and context, and nothing else of Claude's", () => {
    expect(matchCommands(all, "co").map((c) => c.name)).toEqual(["compact", "context"]);
  });

  test("case does not matter", () => {
    expect(matchCommands(all, "COMP").map((c) => c.name)).toEqual(["compact"]);
  });

  test("a namespaced command is found by its last part too, after names that start with the query", () => {
    const list = [command("component"), command("frontend:component", "project")];
    expect(matchCommands(list, "comp").map((c) => c.name)).toEqual(["component", "frontend:component"]);
    expect(matchCommands(list, "front").map((c) => c.name)).toEqual(["frontend:component"]);
  });

  test("a name containing the query comes after the ones starting with it", () => {
    expect(matchCommands([command("autocompact"), command("compact")], "compact").map((c) => c.name)).toEqual(["compact", "autocompact"]);
  });

  test("an empty query is every command, and a query matching none is an empty list", () => {
    expect(matchCommands(all, "")).toHaveLength(all.length);
    expect(matchCommands(all, "Users/me")).toEqual([]);
  });
});

describe("the built-in lists", () => {
  test("each measured agent has a short list of named, described, built-in commands in name order", () => {
    for (const agent of ["claude", "codex", "cursor", "opencode", "agy"]) {
      const list = builtinCommands(agent);
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(15);
      expect(list.map((c) => c.name)).toEqual([...list.map((c) => c.name)].sort());
      for (const c of list) {
        expect(c.source).toBe("builtin");
        expect(c.name).toMatch(/^[a-z][a-z-]*$/);
        expect(c.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("an agent nobody measured gets no commands rather than guessed ones", () => {
    expect(builtinCommands("gemini")).toEqual([]);
    expect(builtinCommands(null)).toEqual([]);
    expect(builtinCommands(undefined)).toEqual([]);
  });

  test("no command that ends the agent is offered from a phone", () => {
    for (const agent of ["claude", "codex", "cursor", "opencode", "agy"]) {
      expect(builtinCommands(agent).map((c) => c.name)).not.toContainAnyValues(["exit", "quit", "logout"]);
    }
  });

  // Measured on Claude Code 2.1.288: the message sent after /usage was
  // accepted and never reached Claude, because the full-screen view took it.
  test("no command that opens a full-screen view, which would take the next message, is offered", () => {
    expect(builtinCommands("claude").map((c) => c.name)).not.toContainAnyValues(["usage", "cost", "status", "config", "help", "resume", "rewind", "permissions", "memory", "mcp"]);
    expect(builtinCommands("cursor").map((c) => c.name)).not.toContain("context");
    expect(builtinCommands("agy").map((c) => c.name)).not.toContain("context");
  });
});

test("merging keeps the first command of each name, in the order given, sorted by name", () => {
  const merged = mergeCommands([command("deploy", "user", "mine")], [command("deploy", "project", "theirs"), command("audit", "project")], [command("compact")]);
  expect(merged).toEqual([command("audit", "project"), command("compact"), command("deploy", "user", "mine")]);
});
