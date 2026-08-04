import { router } from "expo-router";
import { NewSpace } from "@/screens/spaces";
import { useSession } from "@/lib/session";

export default function NewSpaceRoute() {
  const { session, refresh } = useSession();
  if (!session) return null;
  return (
    <NewSpace
      session={session}
      onCreated={() => {
        refresh();
        router.back();
      }}
    />
  );
}
