import { useEffect } from "react";
import { router } from "expo-router";

/**
 * Any path the app has no screen for, and this screen's whole job is to get
 * out of the way.
 *
 * It arrives as a link: a mistyped `shahi://…`, or a malformed or truncated
 * `shahi://pair…` (a readable code never gets here — `+native-intent.tsx`
 * holds it and routes to Connect's confirm card). Nothing on screen asked for
 * it, so it is ignored rather than reported: go back, or start the app as
 * usual on a cold launch.
 *
 * Without this route expo-router mounted its own developer page, "Unmatched
 * Route" with a Sitemap link, outside this app's layout and error boundary;
 * the Sitemap reads `window.location.origin`, which a native Release build
 * does not have, and the app crashed (pre-release bug hunt). app.json turns
 * the generated sitemap off, so `shahi://_sitemap` lands here too.
 */
export default function NotFound() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, []);
  return null;
}
