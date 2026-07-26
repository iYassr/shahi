import { describe, expect, test } from "bun:test";
import { argsForMode, modesFor } from "./modes";

/**
 * These flags were read from `--help` on the machine that runs the agents, and
 * they differ between versions. The tests pin the shape rather than pretending
 * to verify the CLI: what matters here is that an unknown kind offers nothing
 * and an unknown mode adds nothing, because either mistake produces an agent
 * that will not start at all.
 */
describe("modesFor", () => {
  test("offers the ones we have actually checked", () => {
    expect(modesFor("claude").map((m) => m.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypass",
    ]);
    expect(modesFor("codex").length).toBeGreaterThan(2);
  });

  test("offers nothing for an agent whose flags nobody has verified", () => {
    // Inventing one would mean an agent that refuses to start.
    expect(modesFor("pi")).toEqual([]);
    expect(modesFor("opencode")).toEqual([]);
    expect(modesFor(null)).toEqual([]);
  });

  test("the default mode passes no flags at all", () => {
    expect(modesFor("claude")[0]!.args).toEqual([]);
    expect(modesFor("codex")[0]!.args).toEqual([]);
  });

  test("marks the modes that never ask", () => {
    const unsafe = modesFor("claude").filter((m) => m.unsafe).map((m) => m.id);
    expect(unsafe).toEqual(["bypass"]);
  });
});

describe("argsForMode", () => {
  test("resolves a choice to its flags", () => {
    expect(argsForMode("claude", "acceptEdits")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(argsForMode("codex", "full-auto")).toEqual(["--full-auto"]);
  });

  test("adds nothing for anything it does not recognise", () => {
    expect(argsForMode("claude", "nonsense")).toEqual([]);
    expect(argsForMode("nonsense", "bypass")).toEqual([]);
    expect(argsForMode("claude", null)).toEqual([]);
  });
});
