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

  return (
    <div className="choices" role="group" aria-label={prompt.question}>
      {prompt.options.map((option) => {
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
            <span className="choice__index">{option.index}.</span>
            <span className="choice__label">
              {option.label}
              {option.detail && <span className="choice__detail">{option.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
