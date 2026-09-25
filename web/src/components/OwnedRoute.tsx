import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * A pane or space entry in the browser's history belongs to the computer it
 * was opened on, and is never resolved against another one.
 *
 * herdr numbers panes `w1:p1`, `w1:p2`… on every computer, so `/pane/w1%3Ap1`
 * names a different pane on each. The hosted app keeps several computers and
 * routes a notification in place, so after a switch Back reopened the previous
 * computer's entry against the one now selected, and a reply typed there went
 * to the wrong computer (pre-release bug hunt). The entry now records its
 * computer in history state the first time it is shown — which covers every
 * way in, a link, a notification, a reload — and an entry recorded for another
 * computer goes back to the list instead of rendering.
 *
 * `computer` is null where there is only ever one (the locally served app),
 * and then nothing is recorded or refused.
 */
export function OwnedRoute({ computer, children }: { computer: string | null; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { computer?: unknown } | null;
  const owner = typeof state?.computer === "string" ? state.computer : null;
  const foreign = computer !== null && owner !== null && owner !== computer;
  useEffect(() => {
    if (foreign) navigate("/", { replace: true });
    else if (computer !== null && owner === null) {
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: { ...(state ?? {}), computer } });
    }
  }, [foreign, owner, computer, location.key]);
  // Not even one render: the pane view reads and watches its pane at once.
  return foreign ? null : <>{children}</>;
}
