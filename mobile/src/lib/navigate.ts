import { router } from "expo-router";

/**
 * Opens a pane.
 *
 * The object form rather than a template string: pane ids contain a colon
 * (`w4:p2`), and letting the router do the encoding keeps that honest.
 */
export const openPane = (paneId: string) =>
  router.push({ pathname: "/pane/[paneId]", params: { paneId } });
