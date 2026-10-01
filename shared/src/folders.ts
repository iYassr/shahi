/**
 * Folders as a person reads them, for the clients' folder browsers.
 *
 * The computer lists only inside home (`server/lib/dirs.ts`) and shows home as
 * `~`, so a browser's breadcrumb starts at home.
 */

/** The folders on the way from home to `display` (`~/a/b` → Home, a, b). */
export function breadcrumb(display: string): { label: string; display: string }[] {
  if (!display.startsWith("~")) return [{ label: display, display }];
  const parts = display.slice(1).split("/").filter(Boolean);
  return [{ label: "Home", display: "~" }, ...parts.map((part, i) => ({ label: part, display: `~/${parts.slice(0, i + 1).join("/")}` }))];
}

/** What a space in `path` is called unless the person names it: its folder's name. */
export function folderName(path: string): string {
  // Split rather than trim with /\/+$/, which backtracks quadratically over a
  // long run of slashes that does not reach the end (CodeQL, js/polynomial-redos).
  const name = path.split("/").filter(Boolean).pop() ?? "";
  return name === "~" ? "home" : name;
}
