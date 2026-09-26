import { agentLabel, inboxPanes, latestConversations, pinnedPanes, retainPins, togglePin as togglePinOf, type Reviewed } from "@shahi/shared";
import { UiIcon } from "./UiIcon";
import { AgentAvatar } from "./AgentAvatar";
import { preferences } from "../preferences";
/** Latest-message ordering is shared with mobile; grouping is an explicit choice. */
import { useEffect, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import type { AgentStatus, DashboardPane, ParsedPrompt, Session } from "../api";
import { AgentIcon } from "./AgentIcon";
import { Logo } from "./Logo";
import { Prompt } from "./Prompt";
import { useScrollMemory } from "../useScrollMemory";

interface Props {
  reviewed: Reviewed;
  onReviewed: (pane: DashboardPane) => void;
  session: Session | null;
  prompts: Record<string, ParsedPrompt>;
  onAnswer: (paneId: string, optionIndex: number) => Promise<void>;
}


/** herdr's own two, plus agent type. Its wording, so the two agree. */
type Grouping = "priority" | "space" | "agent";

const GROUPINGS: { key: Grouping; label: string }[] = [
  { key: "priority", label: "Latest" },
  { key: "space", label: "Space" },
  { key: "agent", label: "Agent" },
];

const STORED = "shahi.grouping";

export function Dashboard({ session, prompts, onAnswer, reviewed, onReviewed }: Props) {
  const navigate = useNavigate();
  const selected = useMatch("/pane/:paneId")?.params.paneId;
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [storedPins, setStoredPins] = useState<readonly string[]>(() => { try { const stored = JSON.parse(preferences.get("shahi.pins") ?? "[]"); return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []; } catch { return []; } });
  const savePins = (next: readonly string[]) => { preferences.set("shahi.pins", JSON.stringify(next)); setStoredPins(next); };
  // A pin names the conversation it was put on, not only its pane id, and is
  // dropped once that conversation has ended: herdr reuses pane ids, and a pin
  // on w3:p1 starred the next conversation to get that id (pre-release bug
  // hunt). See `pane-instance.ts` in @shahi/shared.
  const pins = pinnedPanes(storedPins, session?.panes ?? []);
  const togglePin = (pane: DashboardPane) => savePins(togglePinOf(storedPins, pane));
  useEffect(() => {
    if (!session) return;
    const kept = retainPins(storedPins, session);
    if (kept !== storedPins) savePins(kept);
  }, [session, storedPins]);

  // Keep explicit grouping choices; default to one chronological list.
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, Boolean(session), "agent-list");

  const [grouping, setGrouping] = useState<Grouping | null>(
    () => (preferences.get(STORED) as Grouping | null) ?? null,
  );

  useEffect(() => {
    if (grouping) preferences.set(STORED, grouping);
  }, [grouping]);

  const effective: Grouping =
    grouping ?? "priority";

  if (!session) {
    return (
      <div className="empty">
        <span className="empty__mark">⟳</span>
        Connecting to your computer…
      </div>
    );
  }

  const inbox = inboxPanes(session.panes, reviewed);
  const inboxIds = new Set(inbox.map((pane) => pane.paneId));
  const allAgents = session.panes.filter((p) => p.isAgent);
  const chips = [{ id: "all", label: "All" }, { id: "inbox", label: `Inbox ${inbox.length}` }, ...(allAgents.some((p) => p.status === "blocked") ? [{ id: "waiting", label: "Waiting" }] : []), ...[...new Set(allAgents.map((p) => p.agent).filter(Boolean))].map((kind) => ({ id: `kind:${kind}`, label: agentLabel(kind!) })), ...(session.panes.some((p) => !p.isAgent) ? [{ id: "shells", label: "Shells" }] : [])];
  const active = chips.some((c) => c.id === filter) ? filter : "all";
  const agents = session.panes.filter((p) => (active === "shells" ? !p.isAgent : p.isAgent && (active === "all" || active === "inbox" && inboxIds.has(p.paneId) || active === "waiting" && p.status === "blocked" || active === `kind:${p.agent}`)) && [p.title, p.agent, p.workspaceLabel, p.cwd, p.paneId].join(" ").toLowerCase().includes(query.toLowerCase()));
  const blocked = active === "inbox" ? latestConversations(agents.filter(p => p.status === "blocked")) : [];
  const rest = latestConversations(active === "inbox" ? agents.filter(p => p.status !== "blocked") : agents, pins);

  if (session.panes.length === 0) {
    return (
      <div className="empty">
        <span className="empty__mark" aria-hidden="true"><Logo size={56} /></span>
        <h2>No agents running.</h2>
        <p>Start an agent in a space to follow its work and reply from here.</p>
        <button className="empty__action" onClick={() => navigate("/spaces")}>Go to spaces</button>
      </div>
    );
  }

  return (
    <div className="scroll" ref={scroller}>
      <div className="page-intro"><h2>Your work, wherever you are</h2><p>{allAgents.filter(p => p.status === "working").length} working · {inbox.length} to review or answer</p></div>
      <div className="agent-search"><UiIcon name="search" /><input aria-label="Search agents" placeholder="Search agents, spaces or folders" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><UiIcon name="close" size={18} /></button>}</div>
      <div className="groupbar agent-filters" role="group" aria-label="Filter agents">{chips.map((chip) => <button className="groupbar__opt" aria-label={chip.label} title={chip.label} aria-pressed={chip.id === active} key={chip.id} onClick={() => setFilter(chip.id)}>
        {chip.id === "inbox" ? <><UiIcon name="inbox" size={19} /><span className="agent-filter-count" aria-hidden="true">{inbox.length}</span></>
          : chip.id.startsWith("kind:") || chip.id === "shells" ? <><span aria-hidden="true"><AgentIcon kind={chip.id === "shells" ? "shell" : chip.id.slice(5)} size={20} /></span>{chip.id === active && <span>{chip.label}</span>}</>
          : chip.label}
      </button>)}</div>
      {active === "inbox" && <div className="inbox-heading"><h2>What needs me?</h2><p>Reply to questions, check unavailable agents, and review completed work.</p></div>}
      {agents.length === 0 && <div className="empty"><p>{active === "inbox" ? query ? "No matching inbox items." : "You’re caught up. New requests and completed work will appear here." : "No matching agents."}</p>{(query || active !== "all") && <button className="empty__action" onClick={() => { setQuery(""); setFilter("all"); }}>Show all agents</button>}</div>}

      <div className="agent-sidebar__requests">{blocked.map((pane) => (
        <button key={pane.paneId} className={`agent-sidebar__request${selected === pane.paneId ? " row--selected" : ""}`} aria-current={selected === pane.paneId ? "page" : undefined} onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}>
          <AgentAvatar kind={pane.agent} status={pane.status} isAgent={pane.isAgent} />
          <span className="row__title">{pane.title ?? pane.paneId}<span className="row__preview">Waiting for your reply</span><span className="row__meta">{pane.workspaceLabel} · Waiting on you</span></span>
        </button>
      ))}</div>
      {!selected && <div className="agent-full-requests">{blocked.map((pane) => (
        <BlockedCard
          key={pane.paneId}
          pane={pane}
          prompt={prompts[pane.paneId]}
          onOpen={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
          onAnswer={(index) => onAnswer(pane.paneId, index)}
        />
      ))}</div>}

      {rest.length > 0 && (
        <>
          {active !== "inbox" && <div className="groupbar" role="group" aria-label="Group agents by">
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
          </div>}

          {groupPanes(rest, active === "inbox" ? "priority" : effective).map((group) => (
            <section key={group.key}>
              <div className="group">
                <h2 className="group__label">
                  {group.icon && <AgentIcon kind={group.icon} />}
                  {active === "inbox" ? "Updates" : group.title}
                  <span className="group__count">{group.panes.length}</span>
                </h2>
              </div>
              {group.panes.map((pane) => (
                pane.status === "blocked" && !selected ? <BlockedCard key={pane.paneId} pane={pane} prompt={prompts[pane.paneId]} onOpen={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)} onAnswer={(index) => onAnswer(pane.paneId, index)} /> : <div className={`agent-row${pins.has(pane.paneId) ? " pinned-agent" : ""}`} key={pane.paneId}><button
                  className={`row row--${pane.status}${selected === pane.paneId ? " row--selected" : ""}`}
                  aria-current={selected === pane.paneId ? "page" : undefined}
                  onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
                >
                  <AgentAvatar kind={pane.agent} status={pane.status} isAgent={pane.isAgent} />
                  <span className="row__title">{pane.title ?? pane.paneId}{active === "inbox" && <span className="inbox-kind">{pane.status === "done" ? "Ready to review" : "Status unavailable"}</span>}<span className="row__preview">{pane.status === "blocked" ? "Waiting for your reply" : pane.status === "working" ? pane.activity?.verb ?? "Working…" : pane.preview ?? pane.cwd ?? ""}</span></span>
                  <span className="row__meta">{subtitle(pane, effective)}</span>
                </button>{active === "inbox" && pane.status === "done" ? <button className="inbox-reviewed" aria-label={`Mark ${pane.title ?? pane.paneId} reviewed`} onClick={() => onReviewed(pane)}>Reviewed</button> : <button className="pin-button" aria-pressed={pins.has(pane.paneId)} aria-label={`${pins.has(pane.paneId) ? "Unpin" : "Pin"} ${pane.title ?? pane.paneId}`} onClick={() => togglePin(pane)}>{pins.has(pane.paneId) ? "★" : "☆"}</button>}</div>
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
    // One chronological list, with explicitly pinned conversations first.
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
