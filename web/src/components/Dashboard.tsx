/**
 * The home screen: which agent needs you, and what it is asking.
 *
 * Density encodes urgency. A blocked agent gets a full card carrying its real
 * question and tappable answers — answering the common case should never
 * require opening anything. Everything else collapses to one dense line.
 *
 * The rest can be grouped by space or by agent type, mirroring herdr's own
 * `ui.agent_panel_sort`. Blocked agents are deliberately *not* grouped: they
 * stay pinned above everything, because burying the one agent waiting on you
 * inside the fifth space would defeat the entire point of the screen.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentStatus, DashboardPane, ParsedPrompt, Session } from "../api";
import { AgentIcon } from "./AgentIcon";
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

/** herdr's own two, plus agent type. Its wording, so the two agree. */
type Grouping = "priority" | "space" | "agent";

const GROUPINGS: { key: Grouping; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "space", label: "Space" },
  { key: "agent", label: "Agent" },
];

const STORED = "herdrui.grouping";

export function Dashboard({ session, prompts, onAnswer }: Props) {
  const navigate = useNavigate();

  // Your explicit choice wins; otherwise follow whatever the TUI is set to;
  // otherwise the attention queue, which is what this screen is for.
  const [grouping, setGrouping] = useState<Grouping | null>(
    () => (localStorage.getItem(STORED) as Grouping | null) ?? null,
  );

  useEffect(() => {
    if (grouping) localStorage.setItem(STORED, grouping);
  }, [grouping]);

  const effective: Grouping =
    grouping ?? ((session?.defaultGrouping as Grouping | null) ?? "priority");

  if (!session) {
    return (
      <div className="empty">
        <span className="empty__mark">⟳</span>
        Connecting to herdr…
      </div>
    );
  }

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
          <div className="groupbar" role="group" aria-label="Group agents by">
            <span className="groupbar__label">Group by</span>
            {GROUPINGS.map((option) => (
              <button
                key={option.key}
                className="groupbar__opt"
                aria-pressed={effective === option.key}
                onClick={() => setGrouping(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {groupPanes(rest, effective).map((group) => (
            <section key={group.key}>
              <div className="group">
                <h2 className="group__label">
                  {group.icon && <AgentIcon kind={group.icon} />}
                  {group.title}
                  <span className="group__count">{group.panes.length}</span>
                </h2>
              </div>
              {group.panes.map((pane) => (
                <button
                  key={pane.paneId}
                  className={`row row--${pane.status}`}
                  onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
                >
                  <span className="row__glyph" aria-hidden="true">
                    {GLYPH[pane.status]}
                  </span>
                  {/* The mark is redundant once the group already says it. */}
                  {effective !== "agent" && <AgentIcon kind={pane.agent} />}
                  <span className="row__title">{pane.title ?? pane.paneId}</span>
                  <span className="row__meta">
                    {effective === "space" ? (pane.agent ?? pane.paneId) : pane.workspaceLabel}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

interface PaneGroup {
  key: string;
  title: string;
  /** Agent kind to draw beside the heading, when grouping by agent. */
  icon?: string | null;
  panes: DashboardPane[];
}

const STATUS_ORDER: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];

export function groupPanes(panes: DashboardPane[], grouping: Grouping): PaneGroup[] {
  if (grouping === "priority") {
    // One group: the server already sorted these by urgency, and re-heading
    // them by status would just restate the glyph in every row.
    return [{ key: "all", title: `${panes.length} agents`, panes }];
  }

  const groups = new Map<string, PaneGroup>();

  for (const pane of panes) {
    const key = grouping === "space" ? pane.workspaceId : (pane.agent ?? "other");
    const title = grouping === "space" ? pane.workspaceLabel : (pane.agent ?? "other");

    let group = groups.get(key);
    if (!group) {
      group = { key, title, icon: grouping === "agent" ? pane.agent : null, panes: [] };
      groups.set(key, group);
    }
    group.panes.push(pane);
  }

  // Groups that need attention float up, then the busiest, then alphabetical —
  // so the ordering still means something rather than being arbitrary.
  const urgency = (group: PaneGroup) =>
    Math.min(...group.panes.map((p) => STATUS_ORDER.indexOf(p.status)));

  return [...groups.values()].sort(
    (a, b) =>
      urgency(a) - urgency(b) ||
      b.panes.length - a.panes.length ||
      a.title.localeCompare(b.title),
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
          <AgentIcon kind={pane.agent} />
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
