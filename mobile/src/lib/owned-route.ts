import { useEffect } from "react";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useSession } from "./session";

/**
 * Whether a pane, space or new-agent route belongs to the computer on screen,
 * and leaves the route when it does not.
 *
 * herdr numbers panes and spaces the same way on every computer, so an id is
 * only meaningful together with its computer. A route pushed while one
 * computer was current survived a switch to another — the stack is not
 * discarded by a remount (see `resetTo` in `navigate.ts`) — and then resolved
 * its id against the new computer: Back showed that computer's `w1:p3`, a
 * reply went into its shell, and a hidden leftover polled it for a pane
 * nobody opened there (pre-release bug hunt). Such a route renders nothing and
 * takes itself off the stack.
 *
 * A route opened by a `shahi://` link names no computer. It is adopted by the
 * computer current when it first renders, and held to that one from then on.
 */
export function useOwnedRoute(): boolean {
  const { computer } = useLocalSearchParams<{ computer?: string }>();
  const { ready, activeComputerId } = useSession();
  const navigation = useNavigation();
  const owner = typeof computer === "string" && computer ? computer : null;
  const owned = activeComputerId !== null && (owner === null || owner === activeComputerId);
  useEffect(() => {
    if (owner === null && activeComputerId !== null) navigation.setParams({ computer: activeComputerId } as never);
  }, [owner, activeComputerId, navigation]);
  useEffect(() => {
    // Before the keychain is read nothing is current yet; that is not a switch.
    if (!ready || owned) return;
    // After the commit, not in it: a switch remounts the stack, and the
    // remounted navigator re-publishes the state it adopted from its own mount
    // effect, which runs after this one and silently undid the pop.
    const later = setTimeout(() => {
      // This route only, wherever it sits: a stale pane can be buried under
      // the new computer's screens, and a plain back would pop one of those.
      if (navigation.canGoBack()) navigation.goBack();
      else router.replace("/");
    });
    return () => clearTimeout(later);
  }, [ready, owned, navigation]);
  return owned;
}
