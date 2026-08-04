import { Spaces } from "@/screens/spaces";
import { useSession } from "@/lib/session";

export default function SpacesTab() {
  const { session } = useSession();
  return <Spaces session={session} />;
}
