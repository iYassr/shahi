/**
 * The third-party notices file that notices-build.ts writes beside the app.
 *
 * Linked from both ways in (Login, PairBrowser) as well as Settings, because
 * the notices travel with the app whether or not it ever connects. Opened in a
 * new tab: in an installed PWA a same-window link to a text file leaves the
 * app with no way back.
 */
export const NOTICES_FILE = "third-party-notices.txt";

export const noticesUrl = () => `${import.meta.env?.BASE_URL ?? "/"}${NOTICES_FILE}`;
