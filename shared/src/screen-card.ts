/**
 * The screen card: what both clients show when an agent is waiting on
 * something no parser recognised (`PaneFrame.unrecognised`), and while a new
 * agent has no conversation to read yet — its startup screens (a sign-in, a
 * terms update, a model change) are answered there, not in a transcript.
 *
 * Shahi cannot tell what these rows mean, so they are shown as the terminal
 * has them, never re-labelled or re-wrapped, with the keys that answer menus.
 */

/** Rows of the screen a card shows. Enough for Codex's folder-trust screen, whole. */
export const SCREEN_CARD_ROWS = 16;

/**
 * The bottom of a screen with its padding removed: trailing spaces on each
 * row, the empty rows below, and empty rows opening what is left. Codex draws
 * its startup screens at the top of an otherwise empty terminal, and Claude
 * Code at the bottom; either way the card starts at the first row with text.
 */
export function screenTail(text: string, rows = SCREEN_CARD_ROWS): string[] {
  const lines = text.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-rows);
  while (tail.length > 0 && tail[0] === "") tail.shift();
  return tail;
}

/**
 * The keys a card offers, in herdr's names. Digits choose a numbered row,
 * arrows and Enter an unnumbered one, and Esc leaves many of them — but not
 * all: on Claude Code's trust, bypass and terms screens it quits the agent,
 * which the screen above the keys is there to show.
 */
export const SCREEN_CARD_KEYS: ReadonlyArray<{ label: string; keys: string[]; name: string }> = [
  { label: "1", keys: ["1"], name: "1" },
  { label: "2", keys: ["2"], name: "2" },
  { label: "3", keys: ["3"], name: "3" },
  { label: "↑", keys: ["Up"], name: "Up arrow" },
  { label: "↓", keys: ["Down"], name: "Down arrow" },
  { label: "Enter", keys: ["Enter"], name: "Enter" },
  { label: "Esc", keys: ["Escape"], name: "Escape" },
];
