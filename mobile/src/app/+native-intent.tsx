import { receivePairingLink } from "@/lib/incoming-pairing";

/**
 * Where a cold launch may begin: the tabs, Connect, and `pair`, which sends a
 * malformed pairing link on to Connect itself.
 */
const LAUNCHABLE = new Set(["", "agents", "spaces", "settings", "connect", "pair"]);

/** The route a link names, without its scheme, query or fragment: `shahi://pane/x` is `pane/x`. */
function routeOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
}

/**
 * Every link the system hands the app passes through here before routing,
 * on a cold launch and while running.
 *
 * A pairing link is held for Connect's confirm card and routed to Connect,
 * whatever computers are saved or on screen; before, only a mounted Connect
 * could see one, and with a computer saved it never was (pre-release review).
 *
 * A cold launch builds a stack of one screen. A hand-made link straight to a
 * space, a pane or a sheet had nothing beneath it: a blank screen, a Close
 * that did nothing, a pane with no back button, and only force-quitting got
 * out (pre-release bug hunt). Shahi itself only ever emits pairing links, so
 * any other cold launch starts at the list. A link opened while the app runs
 * is pushed on top of what is there, and routes as it always did.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    if (receivePairingLink(path)) return "/connect";
    return initial && !LAUNCHABLE.has(routeOf(path)) ? "/" : path;
  } catch {
    // expo-router warns that throwing here can crash the app at launch.
    return path;
  }
}
