/**
 * The answer list for a blocked agent.
 *
 * This is the piece the whole app exists for, and it is deliberately not a set
 * of generic buttons. Claude Code renders a blocked prompt as a numbered list
 * with `❯` marking the selection; the same list is rebuilt here natively — same
 * numbers, same cursor, sized for a thumb. Tapping moves the cursor to that row
 * before the keystroke goes out, so the phone shows what the terminal is about
 * to do.
 */
import { useState } from "react";
import { shownContext, shownLabels } from "@shahi/shared";
import type { ParsedPrompt } from "../api";

interface Props {
  prompt: ParsedPrompt;
  /** Resolves once the keystroke has been delivered. */
  onAnswer: (optionIndex: number) => Promise<void>;
  disabled?: boolean;
}

export function Prompt({ prompt, onAnswer, disabled }: Props) {
  // The row the user has committed to, held until the agent's next frame
  // arrives. Without it the cursor would snap back to the old selection for the
  // fraction of a second before the terminal repaints.
  const [armed, setArmed] = useState<number | null>(null);

  async function answer(index: number) {
    if (armed !== null || disabled) return;
    setArmed(index);
    try {
      await onAnswer(index);
    } catch {
      // Delivery failed, so the terminal never moved. Put the cursor back
      // rather than leaving the UI claiming something that did not happen.
      setArmed(null);
    }
  }

  // Shown without the terminal's key hints; the answer sends the parser's own label.
  const labels = shownLabels(prompt.options);
  return (
    <div className="choices" role="group" aria-label={prompt.question}>
      {prompt.options.map((option, i) => {
        const isArmed = armed === option.index;
        return (
          <button
            key={option.index}
            className="choice"
            data-armed={isArmed}
            data-selected={armed === null && option.selected}
            disabled={disabled || armed !== null}
            onClick={() => void answer(option.index)}
          >
            <span className="choice__cursor" aria-hidden="true">
              ❯
            </span>
            {prompt.answer === "digit" && <span className="choice__index">{option.index}.</span>}
            <span className="choice__label" dir="auto">
              {labels[i]}
              {option.detail && <span className="choice__detail">{option.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What the agent put above its question: the command and the reason behind
 * it, or an edit's diff. One box for every card that shows a prompt, as the
 * native app's `PromptContext` is.
 *
 * Capped and scrollable: a codex approval carries the whole command line, and
 * letting it wrap pushed the answers out of view — which is what "the
 * permission prompt does not show" meant. Not wrapped either: the agent laid
 * these lines out for its terminal, and wrapped to a phone a rule became three
 * lines of dashes and a line of code broke after its comma (first-task test
 * of build 32, October 2026). The rules themselves are dropped; see
 * `shownContext`.
 */
export function PromptContext({ context }: { context: string[] | undefined }) {
  const entries = shownContext(context);
  if (entries.length === 0) return null;
  return (
    <div className="asked__context" dir="ltr">
      {entries.map((entry, i) => (
        <p key={i}>{entry}</p>
      ))}
    </div>
  );
}
