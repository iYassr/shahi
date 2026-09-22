/**
 * Which herdr `herdr-live.test.ts` may write to.
 *
 * That suite creates and closes workspaces, types into shells and presses
 * keys. Its guard used to be "HERDR_SOCKET_PATH is set", which proves nothing
 * inside a herdr pane: herdr sets that variable in every pane it runs, to its
 * own socket, so `SHAHI_HERDR_LIVE=1` typed in the owner's pane would have
 * written into the owner's working session (September 2026 review).
 *
 * Two rules, because neither alone is enough:
 * - The socket must be a named session's. The default session's socket sits
 *   directly in herdr's config directory; a named session's is
 *   `…/herdr/sessions/<name>/herdr.sock`. A bare socket override fails this
 *   too, as it should: `HERDR_SOCKET_PATH=/tmp/x.sock herdr server` restores
 *   the default session and re-launches its agents (CLAUDE.md, Testing).
 * - The session must not be the one this process runs in. Someone whose
 *   working session is itself named passes the first rule with the variable
 *   their pane inherited, so the target is asked for the pane herdr named in
 *   this process's environment.
 */

const NAMED_SESSION_SOCKET = /\/herdr\/sessions\/[^/]+\/herdr\.sock$/;

/** Why the live suite must not run against the configured socket, or null. */
export function liveSocketRefusal(env: Record<string, string | undefined>): string | null {
  const socket = env.HERDR_SOCKET_PATH;
  if (!socket) {
    return "SHAHI_HERDR_LIVE=1 needs HERDR_SOCKET_PATH naming the socket of a named herdr session started for this test";
  }
  if (!NAMED_SESSION_SOCKET.test(socket)) {
    return (
      `SHAHI_HERDR_LIVE=1 refuses ${socket}: it is not a named session's socket (…/herdr/sessions/<name>/herdr.sock). ` +
      "Inside a herdr pane this variable is the pane's own session. Start a named session under a fresh " +
      "XDG_CONFIG_HOME and point HERDR_SOCKET_PATH at it (server/lib/herdr-live.test.ts shows how)"
    );
  }
  return null;
}

/**
 * Whether the herdr that listed `panes` is the one this process runs inside:
 * herdr names the pane in `HERDR_PANE_ID`, and only that session has it.
 * Pane ids are short and per session, so a stale test session could share
 * one by coincidence; that refuses a run it need not have, which is the safe
 * way to be wrong.
 */
export function runsInsideTarget(
  panes: readonly { pane_id: string }[],
  env: Record<string, string | undefined>,
): boolean {
  const own = env.HERDR_PANE_ID;
  return !!own && panes.some((pane) => pane.pane_id === own);
}
