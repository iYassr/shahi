/**
 * Noticing that a new version has been deployed.
 *
 * A home-screen app is resumed far more often than it is launched — iOS keeps
 * it alive for days — so a build deployed this afternoon can go unseen until
 * something evicts it. That turns every fix into "are you sure you reloaded?",
 * which is a miserable way to work on something used from a phone.
 *
 * The HTML names its own bundle, and the bundle's filename carries a content
 * hash. So: fetch the shell, compare, reload if it differs. Cheap enough to do
 * whenever the app comes back to the foreground — the shell is around 600 bytes
 * over the wire.
 */

/** At most this often, however many times the app is foregrounded. */
const MIN_GAP_MS = 60_000;

let lastCheck = 0;

/** The bundle this page is running, from the script tag that loaded it. */
function runningBundle(): string | null {
  for (const script of document.querySelectorAll("script[src]")) {
    const src = (script as HTMLScriptElement).src;
    if (src.includes("/assets/")) return new URL(src).pathname;
  }
  return null;
}

function deployedBundle(html: string): string | null {
  return /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
}

/**
 * Reloads if the server is serving a different build.
 *
 * Deliberately silent: there is no state in this app worth protecting with a
 * "new version available" prompt, and a prompt on a phone is one more thing to
 * dismiss.
 */
export async function reloadIfStale(now: () => number = Date.now): Promise<boolean> {
  if (now() - lastCheck < MIN_GAP_MS) return false;
  lastCheck = now();

  const running = runningBundle();
  if (!running) return false;

  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return false;
    const deployed = deployedBundle(await res.text());
    if (!deployed || deployed === running) return false;
  } catch {
    // Offline, or the server is away. Not the moment to reload.
    return false;
  }

  location.reload();
  return true;
}

/** Exported for testing: the comparison, without the fetch or the reload. */
export const bundles = { running: runningBundle, deployed: deployedBundle };
