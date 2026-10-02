import type { PromptOption } from "./index";

/**
 * What a prompt card shows, as opposed to what the server parsed.
 *
 * Display only. A card posts the parser's own option label, question and
 * context back to `/answer`, and the server compares them with a fresh read
 * of the screen before it presses anything, so nothing here may reach that
 * request: a cleaned label would never match, and every answer would be
 * refused as `prompt_changed`.
 */

/**
 * A line drawn only to separate: Claude Code puts a full-width `─` rule above
 * its permission dialogs and `╌` rules around an edit's diff. At terminal
 * width each is one line; on a phone each wrapped into three lines of dashes
 * above and below the diff (first-task test of build 32, October 2026). Three
 * or more of them, so a lone `-` or `--` that means something stays.
 */
const RULE = /^[\s─-╿‐-―−-]*$/u;
const isRule = (line: string) => RULE.test(line) && line.replace(/\s/gu, "").length >= 3;

/**
 * The context a card shows: each entry as the terminal had it, without its
 * rule lines, and without entries that were nothing else. The lines are not
 * re-flowed: the agent wrapped them for its terminal before Shahi saw them,
 * so a card keeps each whole and scrolls sideways, rather than letting the
 * phone break `return round((total + tip) / people, 2)` after its comma.
 */
export function shownContext(context: readonly string[] | undefined): string[] {
  return (context ?? [])
    .map((entry) => entry.split("\n").filter((line) => !isRule(line)).join("\n"))
    .filter((entry) => entry.trim() !== "");
}

/**
 * A key named at the end of an option, which a phone has no use for: Claude
 * Code's "(shift+tab)" and "(esc)", codex's "(y)" and "(p)", Cursor's "(tab)"
 * and "(esc or n)". One trailing hint, with the space before it, and only in
 * lower case as the terminals print them: "(A)" is more likely the agent's.
 */
const KEY = String.raw`(?:esc|escape|enter|return|tab|space|backspace|(?:shift|ctrl|alt|option|cmd|meta)\s*\+\s*[a-z0-9]+|[a-z])`;
const KEY_HINT = new RegExp(String.raw`\s+\(${KEY}(?:\s*(?:or|/|,)\s*${KEY})*\)$`, "u");

/**
 * The label each option shows, in the options' order. A single letter is a
 * key only as long as the menu still reads without it: an agent's own choices
 * "Plan (a)" and "Plan (b)" would otherwise become two buttons both saying
 * "Plan", so a menu whose labels would collide keeps them as they are.
 */
export function shownLabels(options: readonly Pick<PromptOption, "label">[]): string[] {
  const shown = options.map(({ label }) => label.replace(KEY_HINT, "") || label);
  return new Set(shown).size === shown.length ? shown : options.map(({ label }) => label);
}
