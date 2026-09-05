import { AgentAvatar } from "./AgentAvatar";
import { preferences } from "../preferences";
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
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentStatus, DashboardPane, ParsedPrompt, Session } from "../api";
import { AgentIcon } from "./AgentIcon";
import { Logo } from "./Logo";
import { Prompt } from "./Prompt";
import { useScrollMemory } from "../useScrollMemory";

interface Props {
  session: Session | null;
  prompts: Record<string, ParsedPrompt>;
  onAnswer: (paneId: string, optionIndex: number) => Promise<void>;
}


/** herdr's own two, plus agent type. Its wording, so the two agree. */
type Grouping = "priority" | "space" | "agent";

const GROUPINGS: { key: Grouping; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "space", label: "Space" },
  { key: "agent", label: "Agent" },
];

const STORED = "shahi.grouping";

export function Dashboard({ session, prompts, onAnswer }: Props) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [pins, setPins] = useState<string[]>(() => { try { const stored = JSON.parse(preferences.get("shahi.pins") ?? "[]"); return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []; } catch { return []; } });
  const togglePin = (id: string) => setPins((current) => { const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id]; preferences.set("shahi.pins", JSON.stringify(next)); return next; });

  // Your explicit choice wins; otherwise follow whatever the TUI is set to;
  // otherwise the attention queue, which is what this screen is for.
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, Boolean(session));

  const [grouping, setGrouping] = useState<Grouping | null>(
    () => (preferences.get(STORED) as Grouping | null) ?? null,
  );

  useEffect(() => {
    if (grouping) preferences.set(STORED, grouping);
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

  const allAgents = session.panes.filter((p) => p.isAgent);
  const chips = [{ id: "all", label: "All" }, ...(allAgents.some((p) => p.status === "blocked") ? [{ id: "waiting", label: "Waiting" }] : []), ...[...new Set(allAgents.map((p) => p.agent).filter(Boolean))].map((kind) => ({ id: `kind:${kind}`, label: kind! })), ...(session.panes.some((p) => !p.isAgent) ? [{ id: "shells", label: "Shells" }] : [])];
  const active = chips.some((c) => c.id === filter) ? filter : "all";
  const agents = session.panes.filter((p) => (active === "shells" ? !p.isAgent : p.isAgent && (active === "all" || active === "waiting" && p.status === "blocked" || active === `kind:${p.agent}`)) && [p.title, p.agent, p.workspaceLabel, p.cwd, p.paneId].join(" ").toLowerCase().includes(query.toLowerCase()));
  const blocked = agents.filter((p) => p.status === "blocked");
  const rest = agents.filter((p) => p.status !== "blocked");
  rest.sort((a, b) => Number(pins.includes(b.paneId)) - Number(pins.includes(a.paneId)));

  if (session.panes.length === 0) {
    return (
      <div className="empty">
        <span className="empty__mark" aria-hidden="true"><Logo size={56} /></span>
        No agents running.
      </div>
    );
  }

  return (
    <div className="scroll" ref={scroller}>
      <div className="agent-search"><input aria-label="Search agents" placeholder="Search agents, spaces or folders" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="groupbar agent-filters" role="group" aria-label="Filter agents">{chips.map((chip) => <button className="groupbar__opt" aria-pressed={chip.id === active} key={chip.id} onClick={() => setFilter(chip.id)}>{chip.label}</button>)}</div>
      {agents.length === 0 && <p className="empty">No matching agents.</p>}

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
                <div className={`agent-row${pins.includes(pane.paneId) ? " pinned-agent" : ""}`} key={pane.paneId}><button
                  className={`row row--${pane.status}`}
                  onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
                >
                  <AgentAvatar kind={pane.agent} status={pane.status} isAgent={pane.isAgent} />
                  <span className="row__title">{pane.title ?? pane.paneId}<span className="row__preview">{pane.status === "working" ? pane.activity?.verb ?? "Working…" : pane.preview ?? pane.cwd ?? ""}</span></span>
                  <span className="row__meta">{subtitle(pane, effective)}</span>
                </button><button className="pin-button" aria-pressed={pins.includes(pane.paneId)} aria-label={`${pins.includes(pane.paneId) ? "Unpin" : "Pin"} ${pane.title ?? pane.paneId}`} onClick={() => togglePin(pane.paneId)}>{pins.includes(pane.paneId) ? "★" : "☆"}</button></div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The quiet line under a title: where this agent is, and what it is.
 *
 * Whatever the grouping already says is left out — repeating the space name on
 * every row inside a space heading is noise, and it was the loudest thing on
 * the screen when it sat in its own right-hand column.
 */
function subtitle(pane: DashboardPane, grouping: Grouping): string {
  const parts =
    grouping === "space"
      ? [pane.agent]
      : grouping === "agent"
        ? [pane.workspaceLabel]
        : [pane.workspaceLabel, pane.agent];
  const shown = parts.filter(Boolean);
  return shown.length > 0 ? shown.join(" · ") : pane.paneId;
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
          {prompt.context && prompt.context.length > 0 && (
            <div className="asked__context">
              {prompt.context.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
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
            style={{ color: "var(--accent)", textDecoration: "underline" }}
          >
            Open the terminal
          </button>
        </p>
      )}
    </article>
  );
}
