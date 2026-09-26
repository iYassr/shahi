/**
 * Starts an agent inside an existing space.
 *
 * Two steps under the hood, because herdr's `agent.start` needs a pane already
 * sitting at a shell prompt: create a tab in the space, then start the agent in
 * its root pane. A tab rather than a split — splits are hard to reason about on
 * a phone, and the Spaces view is organised by tab anyway.
 *
 * Only agents that resolve in a real interactive shell are offered. Starting one
 * that is not installed does not fail fast; it fails after herdr has waited its
 * full readiness timeout for a process that was never coming.
 */
import { useEffect, useRef, useState } from "react";
import { agentLabel, modesFor } from "@shahi/shared";
import { useApi, requestId } from "../api";
import { AgentIcon } from "./AgentIcon";
import { DirPicker, type DirChoice } from "./DirPicker";
import { Sheet } from "./Sheet";

interface Props {
  space: { workspaceId: string; label: string; cwd: string | null; cwdPath: string | null };
  onClose: () => void;
  onToast: (message: string) => void;
  /** Called with the pane the agent landed in. */
  onStarted: (paneId: string) => void;
}

type Phase = "idle" | "creating" | "starting";

export function NewAgent({ space, onClose, onToast, onStarted }: Props) {
  const api = useApi();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  // The space this sheet was opened for. herdr gives a closed space's id to
  // the next one after a restart, and the sheet used to follow the id: it
  // retitled itself to the new space and started the agent there, in the old
  // space's folder, with the permissions chosen for the old one (pre-release
  // bug hunt, B43). A space that is no longer the one opened here cannot be
  // started in, and its pending request id is dropped with it.
  const [opened] = useState(() => ({ workspaceId: space.workspaceId, label: space.label }));
  const replaced = space.workspaceId !== opened.workspaceId || space.label !== opened.label;
  useEffect(() => { if (replaced) pending.current = null; }, [replaced]);
  const [available, setAvailable] = useState<{ kind: string; command: string }[] | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<DirChoice>(
    space.cwdPath && space.cwd
      ? { path: space.cwdPath, display: space.cwd }
      : { path: "~", display: "~" },
  );
  // Reset to the safe default whenever the agent changes: modes do not carry
  // across kinds, and inheriting "skip all permissions" silently would be the
  // worst possible way to be helpful.
  const modes = modesFor(kind);
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => setMode(modes[0]?.id ?? null), [kind]);

  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    let live = true;
    void api
      .agents()
      .then((d) => {
        if (!live) return;
        setAvailable(d.agents);
        setKind((current) => current ?? d.agents[0]?.kind ?? null);
      })
      .catch(() => { if (live) onToast("Could not list agents"); });
    return () => { live = false; };
  }, [api, onToast]);

  async function start() {
    if (!kind || inFlight.current || !cwd.path.startsWith("/") || replaced) return;
    inFlight.current = true;
    const fingerprint = JSON.stringify([space.workspaceId, cwd.path, name, kind, mode]);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: requestId() };
    setPhase("creating");
    try {
      setPhase("starting");
      // One call: the server makes the tab and waits for its shell before
      // starting the agent. herdr then waits for the agent to report readiness,
      // which on a cold start is genuinely slow — so the UI says what it is
      // waiting for rather than looking hung.
      const { paneId } = await api.startAgent(
        space.workspaceId,
        cwd.path,
        name.trim() || null,
        kind,
        `${kind.slice(0, 15)}-${pending.current.id.replace(/-/g, "").slice(0, 16)}`,
        mode,
        pending.current.id,
        opened.label,
      );
      if (mounted.current) onStarted(paneId);
    } catch (err) {
      if (!mounted.current) return;
      onToast(err instanceof Error ? err.message : "Could not start the agent");
      setPhase("idle");
    } finally {
      inFlight.current = false;
    }
  }

  const busy = phase !== "idle";

  return (
    <Sheet title={`New agent in ${opened.label}`} onClose={() => { if (!inFlight.current) onClose(); }}>
      {replaced && (
        <p className="picker__error" role="alert">
          {opened.label} was closed on the computer, and another space has taken its place. Close this and
          choose a space again.
        </p>
      )}
      <div className="field">
        <span className="field__label">Agent</span>
        {available === null ? (
          <p className="picker__empty">Looking for installed agents…</p>
        ) : available.length === 0 ? (
          <p className="picker__error">
            No agents found on this machine. Install one and reopen this sheet.
          </p>
        ) : (
          <div className="kinds" role="group" aria-label="Agent">
            {available.map((agent) => (
              <button
                key={agent.kind}
                className="kind"
                data-active={agent.kind === kind}
                aria-pressed={agent.kind === kind}
                onClick={() => setKind(agent.kind)}
                disabled={busy}
              >
                <span aria-hidden="true"><AgentIcon kind={agent.kind} size={15} /></span>
                {agentLabel(agent.kind)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        * How much it may do without asking.
        *
        * Every agent has this setting and every one spells it differently, so
        * it belongs here rather than three prompts later when the agent stops
        * to ask about a `mkdir` — answering those one at a time from a phone is
        * the friction this app exists to remove. Only offered for agents whose
        * flags have actually been checked; the rest start with their own
        * defaults.
        */}
      {modes.length > 0 && (
        <div className="field">
          <span className="field__label">Permissions</span>
          {/* The choice is said as well as drawn: with only `data-active`, a
              screen reader could not tell whether "Skip all permissions" was
              the one selected (pre-release bug hunt). */}
          <div className="modes" role="group" aria-label="Permissions">
            {modes.map((option) => (
              <button
                key={option.id}
                className="mode"
                data-active={option.id === mode}
                aria-pressed={option.id === mode}
                data-unsafe={option.unsafe ?? false}
                onClick={() => setMode(option.id)}
                disabled={busy}
              >
                <span className="mode__label">{option.label}</span>
                {option.unsafe && <span className="mode__caution">No approval before changes</span>}
                <span className="mode__why">{option.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="field">
        <span className="field__label">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind ?? "optional"}
          enterKeyHint="done"
          disabled={busy}
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

      <button
        className="sheet__go"
        onClick={() => void start()}
        disabled={busy || replaced || !kind || !cwd.path.startsWith("/") || available?.length === 0}
      >
        {phase === "creating"
          ? "Making a tab…"
          : phase === "starting"
            ? `Waiting for ${agentLabel(kind ?? "agent")} to be ready…`
            : `Start ${kind ? agentLabel(kind) : "agent"}`}
      </button>
      <p className="sheet__note">
        {busy
          ? "A cold start can take up to five minutes. This stays open until it is ready."
          : "Opens in the background, then takes you to it."}
      </p>
    </Sheet>
  );
}
