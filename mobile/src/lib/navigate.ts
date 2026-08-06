import { router } from "expo-router";

/**
 * Opens a pane.
 *
 * The object form rather than a template string: pane ids contain a colon
 * (`w4:p2`), and letting the router do the encoding keeps that honest.
 */
export const openPane = (paneId: string) =>
  router.push({ pathname: "/pane/[paneId]", params: { paneId } });

/** The same pane, opened on the raw terminal — what a swipe's Screen action means. */
export const openScreen = (paneId: string) =>
  router.push({ pathname: "/pane/[paneId]", params: { paneId, view: "screen" } });
