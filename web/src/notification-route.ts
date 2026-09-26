/**
 * Where a tapped notification lands.
 *
 * A cold launch reads the pane and computer from `/notification?…`. An app that
 * is already open is told by the service worker instead (`public/sw.js`), and
 * routes in place: navigating the window would reload it, and a reload
 * discards unsent drafts and computers paired for this session only. The
 * pre-release review found a notification tap doing exactly that.
 */
import { browserComputers, browserConnection, hosted, selectBrowserComputer } from "./connection";

/** Must match the message `public/sw.js` posts. */
export const OPEN_NOTIFICATION = "shahi:open-notification";

/**
 * `instance` is the occupant of the pane that was waiting, when the server
 * named one. herdr reuses pane ids, so the pane view compares it with the
 * pane's occupant now and says the conversation has ended rather than opening
 * whatever took the id (see `PaneView`).
 */
export async function openNotification(pane: string | null, computer: string | null, go: (path: string) => void, instance: string | null = null): Promise<void> {
  const computers = browserComputers();
  const target = computer ? computers.find(c => c.id === computer) : computers.length === 1 ? computers[0] : undefined;
  if (hosted && !target) { go("/computers"); return; }
  // Switching remounts the session; the notification's own computer needs none.
  if (hosted && target && target.id !== browserConnection().identity?.serverId) await selectBrowserComputer(target.id);
  go(pane ? `/pane/${encodeURIComponent(pane)}${instance ? `?instance=${encodeURIComponent(instance)}` : ""}` : "/");
}

/** Answers the service worker, which navigates the window itself if nobody does. */
export function listenForNotifications(open: (pane: string | null, computer: string | null, instance: string | null) => void): () => void {
  const worker = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!worker) return () => {};
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const receive = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; pane?: unknown; computer?: unknown; instance?: unknown } | null;
    if (data?.type !== OPEN_NOTIFICATION) return;
    event.ports[0]?.postMessage("opened");
    open(text(data.pane), text(data.computer), text(data.instance));
  };
  worker.addEventListener("message", receive);
  return () => worker.removeEventListener("message", receive);
}
