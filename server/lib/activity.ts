/**
 * Extracts Claude Code's live status line from a pane's visible screen.
 *
 * The reader view is fed by the JSONL transcript, which is only written when a
 * message *completes*. Mid-turn it therefore shows nothing new and looks frozen,
 * even though the terminal is visibly counting: `✽ Smooshing… (8m 2s · ↓ 24.1k
 * tokens)`. That line is the missing signal, and it only exists on the screen.
 *
 * Shapes observed on a live agent rather than guessed at:
 *
 *     ✽ Smooshing… (7m 54s · ↓ 23.7k tokens)
 *     · Burrowing… (16s · still thinking with high effort)
 *     ✢ Seasoning… (14m 40s · ↓ 56.6k tokens)
 *     • Working (5s • esc to interrupt)              <- codex
 *
 * The leading glyph is what identifies it, and it cycles — ✻ ✽ ✢ ✳ · * were all
 * seen within a minute. That matters because a superficially similar line,
 * `import { Herd… (5s · 6 lines)`, is a *running tool* rather than the status,
 * and carries no glyph. Anchoring on the glyph separates them; anchoring on the
 * trailing parenthesis would not.
 */

/**
 * Leading glyphs. Claude Code cycles ✻ ✽ ✳ ✶ ✢ · * as an animation; codex uses a
 * static bullet.
 */
const SPINNER = "✻✽✳✶✢✧✦✺∗*·•⋆";

/**
 * The verb and its parenthetical.
 *
 * The parenthetical must *open with an elapsed time*, and that is the whole
 * discriminator. Without it, `• Done (finally)` — an ordinary codex reply that
 * happens to end in brackets — parses as a status line and shows a timer that
 * never moves. Claude marks its verb with `…`; codex does not, so the ellipsis
 * cannot carry the check.
 */
const ACTIVITY = new RegExp(
  String.raw`^[${SPINNER}]\s+([A-Za-z][A-Za-z' -]*…?)\s+\((\d+[ms]\b.*)\)\s*$`,
  "u",
);

/** Claude separates with `·`, codex with `•`. */
const SEPARATOR = /\s[·•]\s/;

export interface Activity {
  /** The gerund Claude Code is showing, e.g. "Smooshing…". */
  verb: string;
  /** Elapsed time as written, e.g. "8m 2s". */
  elapsed: string;
  /** Whatever follows it: "↓ 24.1k tokens", "still thinking with high effort". */
  detail: string | null;
}

/**
 * Returns the current activity, or null when the agent is not mid-turn.
 *
 * Scans from the bottom: the status line lives near the composer, and an older
 * one may still be visible higher up in a screen that has not fully repainted.
 */
export function parseActivity(screen: string): Activity | null {
  const lines = screen.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]!.trim().match(ACTIVITY);
    if (!match) continue;

    const [elapsed, ...rest] = match[2]!.split(SEPARATOR).map((part) => part.trim());
    if (!elapsed) continue;

    return {
      verb: match[1]!,
      elapsed,
      detail: rest.length > 0 ? rest.join(" · ") : null,
    };
  }

  return null;
}
