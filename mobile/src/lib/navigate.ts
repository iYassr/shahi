import { router } from "expo-router";

/**
 * Opens a pane on a computer.
 *
 * The object form rather than a template string: pane ids contain a colon
 * (`w4:p2`), and letting the router do the encoding keeps that honest.
 *
 * The computer travels with the id because herdr numbers panes the same way on
 * every computer: `w1:p3` exists on all of them. A route that carried only the
 * id was resolved against whichever computer was current when it rendered, so
 * after a switch, Back showed another computer's pane under the old id and a
 * reply typed there went to that computer's shell (pre-release bug hunt). The
 * pane route refuses to render for any computer but this one.
 *
 * `instance` is the occupant a notification was about (see the pane route).
 */
export const openPane = (paneId: string, computer: string | null, instance?: string) =>
  router.push({ pathname: "/pane/[paneId]", params: { paneId, ...(computer && { computer }), ...(instance && { instance }) } });

/** The same pane, opened on the raw terminal — what a swipe's Screen action means. */
export const openScreen = (paneId: string, computer: string | null) =>
  router.push({ pathname: "/pane/[paneId]", params: { paneId, view: "screen", ...(computer && { computer }) } });

/** A space on a computer, for the same reason as a pane: workspace ids repeat too. */
export const openSpace = (workspaceId: string, computer: string | null) =>
  router.push({ pathname: "/space/[workspaceId]", params: { workspaceId, ...(computer && { computer }) } });

/**
 * Throws away everything stacked above the tabs and shows `href`.
 *
 * What every change of computer ends with. `<Stack key={connectionKey}>` was
 * meant to do this and does not: expo-router's navigator adopts the
 * container's existing state when it remounts, so `[(tabs), pane]` survived
 * the new key, and the callers' `router.replace("/")` replaced only the top
 * route — the old computer's pane stayed underneath, one Back away. Popping
 * to the root first leaves exactly the new computer's list.
 */
export function resetTo(href: "/" | "/connect") {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}

/** The new computer's Agents list, with nothing of the old one left to go back to. */
export const showComputerHome = () => resetTo("/");
