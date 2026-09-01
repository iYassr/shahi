import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { NewAgent, PickSpace } from "@/screens/spaces";
import { openPane } from "@/lib/navigate";
import { useSession } from "@/lib/session";

/**
 * One sheet for both ways in: a space's own "+ New agent" arrives with its
 * workspaceId, the Agents tab's arrives with none and picks a space first.
 */
export default function NewAgentRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  const [chosen, setChosen] = useState<string | null>(workspaceId ? String(workspaceId) : null);
  const { session, refresh } = useSession();
  if (!session) return null;
  const space = chosen ? session.workspaces.find((w) => w.workspaceId === chosen) : undefined;
  if (!space) return <PickSpace session={session} onPick={(s) => setChosen(s.workspaceId)} />;
  return (
    <NewAgent
      space={space}
      onStarted={(paneId) => {
        refresh();
        // Dismiss the sheet, then land on the agent it started.
        router.back();
        openPane(paneId);
      }}
    />
  );
}
