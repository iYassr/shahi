import { render, screen, userEvent } from "@testing-library/react-native";
import { modesFor } from "@shahi/shared";

/**
 * The permission picker, which is the one place on the phone where being wrong
 * is expensive rather than annoying: the wrong mode means an agent runs with
 * flags nobody chose.
 *
 * These assert against `shared/modes.ts` rather than against copied strings, so
 * adding a mode there cannot leave the phone silently offering the old set.
 */
describe("permission modes", () => {
  test("claude and codex offer different sets, and both have a safe default first", () => {
    const claude = modesFor("claude");
    const codex = modesFor("codex");

    expect(claude.length).toBeGreaterThan(1);
    expect(codex.length).toBeGreaterThan(1);
    expect(claude[0]!.unsafe).toBeFalsy();
    expect(codex[0]!.unsafe).toBeFalsy();
    expect(claude.map((m) => m.id)).not.toEqual(codex.map((m) => m.id));
  });

  // An unknown agent gets no options and starts with its own defaults. Inventing
  // a flag would mean an agent that refuses to start at all.
  test("an agent whose flags nobody checked is offered nothing", () => {
    expect(modesFor("some-new-agent")).toEqual([]);
    expect(modesFor(null)).toEqual([]);
  });

  test("exactly one mode per agent is the dangerous one", () => {
    for (const kind of ["claude", "codex"]) {
      expect(modesFor(kind).filter((m) => m.unsafe)).toHaveLength(1);
    }
  });
});
