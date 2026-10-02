import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { NewAgent, NewSpace, PickSpace } from "@/screens/spaces";
import { Text } from "@/components/text";
import { View } from "react-native";
import { theme } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { useOwnedRoute } from "@/lib/owned-route";

/**
 * One sheet for every way in: a space's own "+ New agent" arrives with its
 * workspaceId; the Agents tab's arrives with none and picks a space first,
 * or, on a computer with no spaces yet, makes one.
 */
export default function NewAgentRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  const [chosen, setChosen] = useState<string | null>(workspaceId ? String(workspaceId) : null);
  /**
   * Whether this sheet starts at the folder. With no spaces it opened on
   * "Choose a space" and nothing to choose: one more screen before the
   * folder, and the word "space" before anything said what it meant
   * (simulator run of build 32, October 2026). Decided once, when the session
   * is first known, so a space made elsewhere meanwhile cannot swap the form
   * out from under a folder being chosen.
   */
  const [first, setFirst] = useState<boolean | null>(workspaceId ? false : null);
  /** A space made from "Choose a space", which goes on to its agent once the session lists it. */
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const { session, refresh, activeComputerId } = useSession();
  // A space's id, like a pane's, means something only on its own computer.
  const owned = useOwnedRoute();
  if (!session || !owned) return null;
  if (first === null) {
    setFirst(session.workspaces.length === 0);
    return null;
  }
  if (making || (first && chosen === null)) {
    // Closing the first space's form leaves New agent: there is no list behind it.
    return <NewSpace session={session} forAgent onCancel={first ? undefined : () => setMaking(false)} onCreated={(id) => { setMaking(false); setMade(id); setChosen(id); void refresh(); }} />;
  }
  const space = chosen ? session.workspaces.find((w) => w.workspaceId === chosen) : undefined;
  if (!space && chosen !== null && chosen === made) {
    // The computer has made it; this session has not heard yet.
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={{ color: theme.dim }}>Opening the new space…</Text></View>;
  }
  if (!space) return <PickSpace session={session} onPick={(s) => setChosen(s.workspaceId)} onNewSpace={() => setMaking(true)} />;
  return (
    <NewAgent
      space={space}
      onStarted={(paneId) => {
        refresh();
        // Replace the creation sheet in one transition; Back returns to the list.
        router.replace({ pathname: "/pane/[paneId]", params: { paneId, ...(activeComputerId && { computer: activeComputerId }) } });
      }}
    />
  );
}
