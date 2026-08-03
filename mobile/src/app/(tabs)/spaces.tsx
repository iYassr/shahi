import { Spaces } from "@/screens/spaces";
import { useSession } from "@/lib/session";
import { openPane } from "@/lib/navigate";

export default function SpacesTab() {
  const { session, refresh } = useSession();
  return <Spaces session={session} onOpenPane={openPane} onChanged={refresh} />;
}
