/**
 * Which saved Claude conversation runs in a pane herdr cannot identify.
 *
 * A Claude started before herdr's integration was installed reports no
 * session, so Reader cannot know which transcript is its own
 * (server/lib/claude-choice.ts). The person can: the computer lists the
 * conversations saved for the folder Claude runs in, with the one Claude's
 * process record names marked likely, and nothing is chosen for them.
 */
import { useEffect, useState } from "react";
import { relativeTime } from "@shahi/shared";
import { useApi, type ConversationChoice } from "../api";

interface Props {
  paneId: string;
  /** Who held the pane when the list was asked for; a choice for another is refused. */
  instanceId?: string;
  onChosen: () => void;
  onCancel: () => void;
}

export function ConversationPicker({ paneId, instanceId, onChosen, onCancel }: Props) {
  const api = useApi();
  const [choices, setChoices] = useState<ConversationChoice[] | null>(null);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    let live = true;
    api.conversationChoices(paneId).then(
      (found) => { if (live) setChoices(found.choices); },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : "The conversations could not be listed."); },
    );
    return () => { live = false; };
  }, [api, paneId]);

  async function choose(sessionId: string) {
    setChoosing(true);
    setError("");
    try {
      await api.chooseConversation(paneId, sessionId, instanceId);
      onChosen();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That conversation could not be chosen.");
      setChoosing(false);
    }
  }

  return (
    <section className="choices" aria-label="Choose the conversation">
      <h3>Which conversation is this?</h3>
      <p>Claude started here before Shahi could identify it. Choose the conversation it is running, and Reader will show it.</p>
      {error && <p role="alert">{error}</p>}
      {!choices && !error && <p role="status">Looking for conversations…</p>}
      {choices?.length === 0 && <p role="status">No saved Claude conversations were found for this folder.</p>}
      {!!choices?.length && (
        <ul className="choices__list">
          {choices.map((choice) => (
            <li key={choice.sessionId}>
              <button className="choices__item" disabled={choosing} onClick={() => void choose(choice.sessionId)}>
                <span className="choices__title">
                  {choice.firstPrompt ?? "Untitled conversation"}
                  {choice.likely && <span className="choices__likely">Likely</span>}
                </span>
                {choice.lastMessage && <span className="choices__last">{choice.lastMessage}</span>}
                <span className="choices__when">{relativeTime(choice.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="empty__action" onClick={onCancel}>Cancel</button>
    </section>
  );
}
