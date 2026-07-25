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
import { api } from "../api";
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
      const { result } = await api.createTab(space.workspaceId, name.trim() || null, cwd.path);
      const paneId = (result as { root_pane?: { pane_id: string } }).root_pane?.pane_id;
      if (!paneId) throw new Error("herdr created the tab without telling us the pane");

      setPhase("starting");
      // herdr waits for the agent to report readiness. On a cold start that is
      // genuinely slow, so the UI says what it is waiting for rather than
      // looking hung.
      await api.startAgent(paneId, kind, name.trim() || kind);
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
                {agent.kind}
              </button>
            ))}
          </div>
        )}
      </div>

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
