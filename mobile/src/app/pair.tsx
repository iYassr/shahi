import { useEffect } from "react";
import { router } from "expo-router";

/**
 * `shahi://pair…` that is not a readable pairing code lands here, and this
 * screen's whole job is to get out of the way.
 *
 * A readable code never gets this far: `+native-intent.tsx` holds it and
 * routes to Connect's confirm card. What is left is a malformed or truncated
 * link. It has to route somewhere or expo-router shows its unmatched-route
 * page, and nothing on screen asked for it, so it is ignored rather than
 * reported: go back, or to Connect on a cold launch.
 */
export default function Pair() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/connect");
  }, []);
  return null;
}
