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
import { useEffect, useState } from "react";
import { modesFor } from "@herdrui/shared";
import { api } from "../api";
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
    void api
      .agents()
      .then((d) => {
        setAvailable(d.agents);
        setKind((current) => current ?? d.agents[0]?.kind ?? null);
      })
      .catch(() => onToast("Could not list agents"));
  }, [onToast]);

  async function start() {
    if (!kind) return;
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
        name.trim() || kind,
        mode,
      );
      onStarted(paneId);
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Could not start the agent");
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";

  return (
    <Sheet title={`New agent in ${space.label}`} onClose={onClose}>
      <div className="field">
        <span className="field__label">Agent</span>
        {available === null ? (
          <p className="picker__empty">Looking for installed agents…</p>
        ) : available.length === 0 ? (
          <p className="picker__error">
            No agents found on this machine. Install one and reopen this sheet.
          </p>
        ) : (
          <div className="kinds">
            {available.map((agent) => (
              <button
                key={agent.kind}
                className="kind"
                data-active={agent.kind === kind}
                onClick={() => setKind(agent.kind)}
                disabled={busy}
              >
                <AgentIcon kind={agent.kind} size={15} />
                {agent.kind}
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
          <div className="modes">
            {modes.map((option) => (
              <button
                key={option.id}
                className="mode"
                data-active={option.id === mode}
                data-unsafe={option.unsafe ?? false}
                onClick={() => setMode(option.id)}
                disabled={busy}
              >
                <span className="mode__label">{option.label}</span>
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
        disabled={busy || !kind || available?.length === 0}
      >
        {phase === "creating"
          ? "Making a tab…"
          : phase === "starting"
            ? `Waiting for ${kind} to be ready…`
            : `Start ${kind ?? "agent"}`}
      </button>
      <p className="sheet__note">
        {busy
          ? "A cold start can take half a minute. This stays open until it is ready."
          : "Opens in the background, then takes you to it."}
      </p>
    </Sheet>
  );
}
