import { useEffect } from "react";
import { router } from "expo-router";

/**
 * `shahi://pair#…` lands here, and this screen's whole job is to get out of
 * the way.
 *
 * The link has to route somewhere or expo-router shows its unmatched-route
 * page, but it must not mount a second Connect: `useURL()` delivers the link
 * to the Connect *already* mounted at /connect, and a second instance's own
 * `useURL()` is null. Traced on a simulator, the first instance armed the
 * confirm card correctly and the second one — on top, and the one you could
 * see — showed the intro. The pairing link did nothing and said nothing.
 *
 * Rendering Connect here was the original bug. Redirecting to /connect was the
 * second version and no better: a redirect *navigates*, so it pushed another
 * /connect rather than returning to the one holding the payload.
 *
 * So: go back. Dismissing this screen reveals the Connect underneath, the one
 * the link actually reached. On a cold launch there is nothing to go back to,
 * and then a single Connect is created — which reads the same link from the
 * initial URL, so that path works too.
 */
export default function Pair() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/connect");
  }, []);
  return null;
}
