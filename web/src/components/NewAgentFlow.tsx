/**
 * "+ New agent" from the Agents list: which space, then the agent.
 *
 * With no spaces yet it starts at the folder instead. It opened on "Choose a
 * space" with nothing to choose and a button that left for the Spaces tab, a
 * dead end that also used the word "space" before anything said what it meant
 * (simulator run of build 32, October 2026). Whether it starts there is
 * decided once, when the sheet opens, so a space made elsewhere meanwhile
 * cannot swap the form out from under a folder being chosen. The native
 * route, `mobile/src/app/new-agent.tsx`, takes the same steps.
 */
import { useEffect, useState } from "react";
import type { Session } from "../api";
import { NewAgent } from "./NewAgent";
import { Sheet } from "./Sheet";
import { CreateSpace } from "./Spaces";

interface Props {
  session: Session;
  onClose: () => void;
  onToast: (message: string) => void;
  /** Asks for a fresh session, after making a space. */
  onChanged: () => void;
  /** Called with the pane the agent landed in. */
  onStarted: (paneId: string) => void;
}

export function NewAgentFlow({ session, onClose, onToast, onChanged, onStarted }: Props) {
  const [first] = useState(() => session.workspaces.length === 0);
  const [making, setMaking] = useState(first);
  const [chosen, setChosen] = useState<string | null>(null);
  /** A space made here, which goes on to its agent once the session lists it. */
  const [made, setMade] = useState<string | null>(null);
  const space = chosen ? session.workspaces.find((s) => s.workspaceId === chosen) : undefined;

  // A chosen space that closes goes back to choosing one, rather than leaving
  // the form open for the next space herdr gives the same id (pre-release bug
  // hunt, B43). A space made here is not gone before the session first lists it.
  useEffect(() => {
    if (!chosen) return;
    if (space) { if (made === chosen) setMade(null); return; }
    if (chosen !== made) setChosen(null);
  }, [chosen, space, made]);

  if (making) {
    return (
      <CreateSpace
        session={session}
        forAgent
        // The first space's form has no list behind it to return to.
        onClose={first ? onClose : () => setMaking(false)}
        onToast={onToast}
        onCreated={(workspaceId) => { setMaking(false); setMade(workspaceId); setChosen(workspaceId); onChanged(); }}
      />
    );
  }
  if (space) return <NewAgent space={space} onClose={onClose} onToast={onToast} onStarted={onStarted} />;
  if (chosen && chosen === made) {
    // The computer has made it; this session has not heard yet.
    return <Sheet title="New agent" onClose={onClose}><p className="sheet__note" role="status">Opening the new space…</p></Sheet>;
  }
  return (
    <Sheet title="Choose a space" onClose={onClose}>
      {/* A new agent often wants a new folder (device audit, build 28). */}
      <button className="bigaction sheet__new" onClick={() => setMaking(true)}>+ New space</button>
      {session.workspaces.map((s) => (
        <button className="row" key={s.workspaceId} onClick={() => setChosen(s.workspaceId)}>{s.label}</button>
      ))}
    </Sheet>
  );
}
