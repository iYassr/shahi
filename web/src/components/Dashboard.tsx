/**
 * The home screen: which agent needs you, and what it is asking.
 *
 * Density encodes urgency. A blocked agent gets a full card carrying its real
 * question and tappable answers — answering the common case should never
 * require opening anything. Everything else collapses to one dense line.
 */
import { useNavigate } from "react-router-dom";
import type { AgentStatus, DashboardPane, ParsedPrompt, Session } from "../api";
import { Prompt } from "./Prompt";

interface Props {
  session: Session | null;
  prompts: Record<string, ParsedPrompt>;
  onAnswer: (paneId: string, optionIndex: number) => Promise<void>;
}

/**
 * Status glyphs, borrowed from the vocabulary of the terminal itself rather
 * than invented: a filled ring for work in progress, a check for a finished
 * turn, a hollow ring for idle.
 */
const GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "◐",
  done: "✓",
  idle: "○",
  unknown: "·",
};

export function Dashboard({ session, prompts, onAnswer }: Props) {
  const navigate = useNavigate();

  if (!session) {
    return (
      <div className="empty">
        <span className="empty__mark">⟳</span>
        Connecting to herdr…
      </div>
    );
  }

  // Plain shells are roughly half the panes in a real session and would bury
  // the agents. They stay reachable from the workspace they belong to.
  const agents = session.panes.filter((p) => p.isAgent);
  const blocked = agents.filter((p) => p.status === "blocked");
  const rest = agents.filter((p) => p.status !== "blocked");

  if (agents.length === 0) {
    return (
      <div className="empty">
        <span className="empty__mark">○</span>
        No agents running.
      </div>
    );
  }

  return (
    <div className="scroll">
      {blocked.map((pane) => (
        <BlockedCard
          key={pane.paneId}
          pane={pane}
          prompt={prompts[pane.paneId]}
          onOpen={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
          onAnswer={(index) => onAnswer(pane.paneId, index)}
        />
      ))}

      {rest.length > 0 && (
        <>
          <div className="group">
            <h2 className="group__label">
              {blocked.length > 0 ? "Everything else" : `${rest.length} agents`}
            </h2>
          </div>
          {rest.map((pane) => (
            <button
              key={pane.paneId}
              className={`row row--${pane.status}`}
              onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
            >
              <span className="row__glyph" aria-hidden="true">
                {GLYPH[pane.status]}
              </span>
              <span className="row__title">{pane.title ?? pane.paneId}</span>
              <span className="row__meta">{pane.workspaceLabel}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function BlockedCard({
  pane,
  prompt,
  onOpen,
  onAnswer,
}: {
  pane: DashboardPane;
  prompt: ParsedPrompt | undefined;
  onOpen: () => void;
  onAnswer: (optionIndex: number) => Promise<void>;
}) {
  return (
    <article className="blocked">
      <button className="blocked__head" onClick={onOpen}>
        <span className="blocked__badge">
          <span aria-hidden="true">●</span> Waiting on you
        </span>
        <h2 className="blocked__where">{pane.workspaceLabel}</h2>
        <p className="blocked__task">
          {pane.agent ?? "agent"} · {pane.paneId} · {pane.title ?? "untitled"}
        </p>
      </button>

      {prompt ? (
        <>
          <p className="blocked__question">{prompt.question}</p>
          <Prompt prompt={prompt} onAnswer={onAnswer} />
        </>
      ) : (
        // The agent is blocked but the screen has no list we can act on — a
        // free-text prompt, or something the parser does not recognise. Say so
        // and hand off to the full view rather than guessing.
        <p className="blocked__question">
          This one needs a typed reply.{" "}
          <button
            onClick={onOpen}
            style={{ color: "var(--peach)", textDecoration: "underline" }}
          >
            Open the terminal
          </button>
        </p>
      )}
    </article>
  );
}
