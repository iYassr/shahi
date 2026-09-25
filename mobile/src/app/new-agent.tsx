import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { NewAgent, PickSpace } from "@/screens/spaces";
import { useSession } from "@/lib/session";
import { useOwnedRoute } from "@/lib/owned-route";

/**
 * One sheet for both ways in: a space's own "+ New agent" arrives with its
 * workspaceId, the Agents tab's arrives with none and picks a space first.
 */
export default function NewAgentRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  const [chosen, setChosen] = useState<string | null>(workspaceId ? String(workspaceId) : null);
  const { session, refresh, activeComputerId } = useSession();
  // A space's id, like a pane's, means something only on its own computer.
  const owned = useOwnedRoute();
  if (!session || !owned) return null;
  const space = chosen ? session.workspaces.find((w) => w.workspaceId === chosen) : undefined;
  if (!space) return <PickSpace session={session} onPick={(s) => setChosen(s.workspaceId)} />;
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
