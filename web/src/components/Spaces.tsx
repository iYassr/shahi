/**
 * The Spaces half of the app, mirroring how herdr splits its own sidebar.
 *
 * Agents is for triage — what needs you right now. Spaces is for structure —
 * where things live, and where new work goes. Plain shells, which the Agents
 * view filters out, are reachable here: on the phone this is the only way to
 * get at roughly half the panes in a real session.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type AgentStatus, type Session } from "../api";
import { AgentIcon } from "./AgentIcon";
import { DirPicker, type DirChoice } from "./DirPicker";
import { NewAgent } from "./NewAgent";
import { Sheet } from "./Sheet";
import { useScrollMemory } from "../useScrollMemory";

const GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "◐",
  done: "✓",
  idle: "○",
  unknown: "·",
};

/**
 * Fallback when a space has no path to inherit.
 *
 * `path` is filled in from the first directory listing, since only the server
 * knows the real home directory — and an unexpanded `~` would land in the wrong
 * place without complaining.
 */
const HOME_CHOICE: DirChoice = { path: "~", display: "~" };

interface Props {
  session: Session | null;
  onToast: (message: string) => void;
  onChanged: () => void;
}

/**
 * Shortens a path by dropping its head.
 *
 * The end of a path is what identifies it — `~/work/clients/acme/site` and
 * `~/work/clients/beta/site` differ in the middle, and truncating from the
 * right would leave both reading `~/work/clients/…`.
 */
export function fromTheLeft(path: string, keep = 30): string {
  if (path.length <= keep) return path;
  const tail = path.slice(-(keep - 1));
  const cut = tail.indexOf("/");
  // Start at a segment boundary where there is one nearby, so the result never
  // begins mid-word.
  return `…${cut >= 0 && cut < 8 ? tail.slice(cut) : tail}`;
}

export function Spaces({ session, onToast, onChanged }: Props) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, Boolean(session));

  if (!session) {
    return (
      <div className="empty">
        <span className="empty__mark">⟳</span>
        Connecting to herdr…
      </div>
    );
  }

  return (
    <>
      <div className="scroll" ref={scroller}>
        {session.workspaces.map((space) => {
          const panes = session.panes.filter((p) => p.workspaceId === space.workspaceId);
          const agents = panes.filter((p) => p.isAgent);
          const blocked = agents.filter((p) => p.status === "blocked").length;
          const working = agents.filter((p) => p.status === "working").length;
          const shells = panes.length - agents.length;

          /*
           * What is happening here, rather than how it is arranged.
           *
           * This row used to read "~/pc · 6 tabs · 6 panes" — the count of tabs
           * is herdr's filing system, not news, and it left two spaces both
           * called `pc` distinguishable only by a number that means nothing to
           * anyone. What you actually want to know from a list of spaces is
           * where the work is: how many agents, how many are running, and
           * whether any of them is waiting on you.
           */
          const summary = [
            agents.length > 0 && `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
            working > 0 && `${working} running`,
            agents.length === 0 && shells > 0 && `${shells} shell${shells === 1 ? "" : "s"}`,
            agents.length === 0 && shells === 0 && "empty",
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <button
              key={space.workspaceId}
              className={`space${blocked > 0 ? " space--blocked" : ""}`}
              onClick={() => navigate(`/space/${encodeURIComponent(space.workspaceId)}`)}
            >
              <span className="space__body">
                <span className="space__top">
                  <span className="space__name">{space.label}</span>
                  {blocked > 0 && (
                    <span className="space__badge">
                      {blocked} waiting
                    </span>
                  )}
                </span>

                <span className="space__meta">
                  {/*
                   * One dot per agent, in its own status colour: the shape of
                   * the space at a glance, and the thing that finally tells two
                   * spaces of the same name apart.
                   */}
                  {agents.length > 0 && (
                    <span className="space__dots" aria-hidden="true">
                      {agents.slice(0, 12).map((p) => (
                        <i key={p.paneId} className={`space__dot space__dot--${p.status}`} />
                      ))}
                    </span>
                  )}
                  <span className="space__summary">{summary}</span>
                  {/* Shortened in JS rather than with `direction: rtl`, which
                      puts the ellipsis in the right place and the path segments
                      in the wrong order — `~/MediaProduction/test` came out as
                      `MediaProduction/test/~`. This project has made that
                      mistake before. */}
                  <span className="space__path">{fromTheLeft(space.cwd ?? space.workspaceId)}</span>
                </span>
              </span>
            </button>
          );
        })}

        <button className="bigaction" onClick={() => setCreating(true)}>
          + New space
        </button>
      </div>

      {creating && (
        <CreateSpace
          session={session}
          onClose={() => setCreating(false)}
          onToast={onToast}
          onCreated={(workspaceId) => {
            setCreating(false);
            onChanged();
            navigate(`/space/${encodeURIComponent(workspaceId)}`);
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

export function SpaceDetail({ session, onToast, onChanged }: Props) {
  const { workspaceId = "" } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState<"tab" | "agent" | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, Boolean(session));

  const space = session?.workspaces.find((w) => w.workspaceId === workspaceId);
  const tabs = useMemo(
    () => (session?.tabs ?? []).filter((t) => t.workspaceId === workspaceId),
    [session, workspaceId],
  );

  if (!session) return null;
  if (!space) {
    return (
      <div className="empty">
        <span className="empty__mark">○</span>
        That space is gone.
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <button className="topbar__back" onClick={() => navigate("/spaces")} aria-label="Back">
          ‹
        </button>
        <div>
          <div className="detail__task">{space.label}</div>
          <div className="detail__where">{space.cwd ?? space.workspaceId}</div>
        </div>
      </header>

      <div className="scroll" ref={scroller}>
        {tabs.map((tab) => {
          const panes = session.panes.filter((p) => p.tabId === tab.tabId);

          /*
           * `label` is herdr's display position (1..n) and `number` is its
           * internal id, which diverge as tabs are closed — showing both reads
           * as "Tab 5 · 3" and means nothing. A renamed tab puts its name in
           * `label`, so a non-numeric label is a real name.
           */
          const named = !/^\d+$/.test(tab.label);

          /*
           * A heading only where a tab holds more than one pane.
           *
           * Almost every tab holds exactly one, and a "TAB 3" line above every
           * single row meant two lines of chrome per item — most of the screen
           * spent labelling rather than listing. The tab is still identified,
           * on the row itself, where it costs nothing.
           */
          const grouped = panes.length > 1 || named;

          return (
            <section key={tab.tabId}>
              {grouped && (
                <div className="group">
                  <h2 className="group__label">{named ? tab.label : `Tab ${tab.label}`}</h2>
                  {panes.length > 1 && <span className="group__count">{panes.length}</span>}
                </div>
              )}

              {panes.map((pane) => (
                <button
                  key={pane.paneId}
                  className={`row row--${pane.status}`}
                  onClick={() => navigate(`/pane/${encodeURIComponent(pane.paneId)}`)}
                >
                  <span className="row__glyph" aria-hidden="true">
                    {GLYPH[pane.status]}
                  </span>
                  {pane.isAgent && <AgentIcon kind={pane.agent} />}
                  <span className="row__title">
                    {pane.title ?? (pane.isAgent ? pane.paneId : "shell")}
                  </span>
                  {/* Which tab, on the row, instead of a heading above it. */}
                  {!grouped && <span className="row__tab">{tab.label}</span>}
                  {/* The agent's kind, or — for a shell, whose title already
                      says "shell" — which pane it is. */}
                  <span className="row__meta">{pane.agent ?? pane.paneId}</span>
                </button>
              ))}
            </section>
          );
        })}

        {/*
          * Starting an agent is the common case and gets the primary control;
          * a bare tab is the occasional one and sits underneath it.
          */}
        <button className="bigaction bigaction--primary" onClick={() => setCreating("agent")}>
          + New agent
        </button>
        <button className="bigaction" onClick={() => setCreating("tab")}>
          + Empty tab
        </button>
      </div>

      {creating === "tab" && (
        <CreateTab
          space={space}
          onClose={() => setCreating(null)}
          onToast={onToast}
          onCreated={() => {
            setCreating(null);
            onChanged();
          }}
        />
      )}

      {creating === "agent" && (
        <NewAgent
          space={space}
          onClose={() => setCreating(null)}
          onToast={onToast}
          onStarted={(paneId) => {
            setCreating(null);
            onChanged();
            navigate(`/pane/${encodeURIComponent(paneId)}`);
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function CreateSpace({
  session,
  onClose,
  onToast,
  onCreated,
}: {
  session: Session;
  onClose: () => void;
  onToast: (message: string) => void;
  onCreated: (workspaceId: string) => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<DirChoice>(HOME_CHOICE);
  const [busy, setBusy] = useState(false);

  // A new space usually sits beside an existing one, so offer those first.
  const suggestions = useMemo(() => {
    const seen = new Map<string, DirChoice>();
    for (const w of session.workspaces) {
      if (w.cwdPath && w.cwd && !seen.has(w.cwdPath)) {
        seen.set(w.cwdPath, { path: w.cwdPath, display: w.cwd });
      }
    }
    return [...seen.values()];
  }, [session]);

  async function create() {
    setBusy(true);
    try {
      const { result } = await api.createSpace(name.trim() || "new space", cwd.path);
      const created = result as { workspace?: { workspace_id: string } };
      onCreated(created.workspace?.workspace_id ?? "");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not create the space");
      setBusy(false);
    }
  }

  return (
    <Sheet title="New space" onClose={onClose}>
      <label className="field">
        <span className="field__label">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="what you are working on"
          autoFocus
          enterKeyHint="done"
        />
      </label>

      <div className="field">
        <span className="field__label">Folder</span>
        <DirPicker value={cwd} onChange={setCwd} suggestions={suggestions} />
      </div>

      <button className="sheet__go" onClick={() => void create()} disabled={busy}>
        {busy ? "Creating…" : "Create space"}
      </button>
      <p className="sheet__note">
        Opens in the background. Your desktop view will not jump to it.
      </p>
    </Sheet>
  );
}

function CreateTab({
  space,
  onClose,
  onToast,
  onCreated,
}: {
  space: { workspaceId: string; label: string; cwd: string | null; cwdPath: string | null };
  onClose: () => void;
  onToast: (message: string) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<DirChoice>(
    space.cwdPath && space.cwd ? { path: space.cwdPath, display: space.cwd } : HOME_CHOICE,
  );
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.createTab(space.workspaceId, name.trim() || null, cwd.path);
      onCreated();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not create the tab");
      setBusy(false);
    }
  }

  return (
    <Sheet title={`New tab in ${space.label}`} onClose={onClose}>
      <label className="field">
        <span className="field__label">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="optional"
          autoFocus
          enterKeyHint="done"
        />
      </label>

      <div className="field">
        <span className="field__label">Folder</span>
        <DirPicker
          value={cwd}
          onChange={setCwd}
          suggestions={
            space.cwdPath && space.cwd ? [{ path: space.cwdPath, display: space.cwd }] : []
          }
        />
      </div>

      <button className="sheet__go" onClick={() => void create()} disabled={busy}>
        {busy ? "Creating…" : "Create tab"}
      </button>
    </Sheet>
  );
}
