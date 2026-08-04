import { router, useLocalSearchParams } from "expo-router";
import { NewAgent } from "@/screens/spaces";
import { openPane } from "@/lib/navigate";
import { useSession } from "@/lib/session";

export default function NewAgentRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const { session, refresh } = useSession();
  const space = session?.workspaces.find((w) => w.workspaceId === String(workspaceId));
  if (!space) return null;
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
