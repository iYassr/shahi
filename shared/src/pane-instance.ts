/**
 * Keeping things per conversation when herdr reuses a pane id.
 *
 * herdr gives a closed pane's id to a new pane after a restart (close the
 * highest space, restart, create one: it gets the same id), and every named
 * session starts at w1:p1. The pre-release bug hunt found everything the
 * clients kept under a bare pane id following the id to its next holder: a
 * draft typed for one conversation in another's composer, a retried send
 * typed into a new shell, a remembered conversation under a new header, a pin
 * on the wrong row and a notification opening the wrong conversation.
 *
 * The server names each pane's occupant (`DashboardPane.instanceId`). What a
 * client holds only in memory stays keyed by pane id and is forgotten when a
 * session says that occupant has ended (`endedPanes`); what it stores, a pin,
 * carries the occupant with it. An older server names no occupant, and
 * everything here then falls back to the pane id, as the clients always did.
 */
import type { DashboardPane, Session } from "./index";

type Occupied = Pick<DashboardPane, "paneId" | "instanceId">;
type Snapshot = Pick<Session, "version"> & { panes: readonly Occupied[] };

/**
 * Whether something kept for occupant `kept` still belongs to the pane's
 * occupant `now`. Not knowing either is not a difference: an older server
 * names none, and something kept before the list loaded has not said.
 */
export function sameOccupant(kept: string | null | undefined, now: string | null | undefined): boolean {
  return !kept || !now || kept === now;
}

/**
 * The panes whose conversation ended between two sessions from one computer:
 * closed, or held by another program under the same id. What a client kept
 * for them — a draft, an uncertain send's operation id, a remembered
 * conversation and place — belongs to nobody now.
 *
 * Only a real snapshot says which panes exist. Before its first one the
 * sidecar reports no panes at all (`version` is still empty), and every herdr
 * start restarts the sidecar, so reading that as "everything closed" would
 * drop every draft on every restart.
 */
export function endedPanes(before: Snapshot | null | undefined, after: Snapshot): string[] {
  if (!before?.version || !after.version) return [];
  const now = new Map(after.panes.map((pane) => [pane.paneId, pane]));
  return before.panes
    .filter((pane) => { const held = now.get(pane.paneId); return !held || !sameOccupant(pane.instanceId, held.instanceId); })
    .map((pane) => pane.paneId);
}

/*
 * A pin is stored as its pane id and, since servers named occupants, the
 * occupant it was pinned on, after a newline: neither herdr's pane ids nor its
 * terminal ids can hold one, and a string keeps what both clients already
 * store (a list of strings) readable by the same code.
 */
function pinFor(pane: Occupied): string {
  return pane.instanceId ? `${pane.paneId}\n${pane.instanceId}` : pane.paneId;
}

function split(pin: string): Occupied {
  const at = pin.indexOf("\n");
  return at === -1 ? { paneId: pin } : { paneId: pin.slice(0, at), instanceId: pin.slice(at + 1) };
}

/**
 * The pane ids pinned now. Pins were bare pane ids, and the pre-release bug
 * hunt pinned w3:p1, closed w3, restarted herdr and created a space: the new
 * conversation in w3:p1 came up starred. A pin stored before occupants were
 * named still matches by id until `retainPins` records whose it is.
 */
export function pinnedPanes(pins: readonly string[], panes: readonly Occupied[]): Set<string> {
  const byId = new Map(panes.map((pane) => [pane.paneId, pane]));
  const pinned = new Set<string>();
  for (const pin of pins) {
    const { paneId, instanceId } = split(pin);
    const pane = byId.get(paneId);
    if (pane && sameOccupant(instanceId, pane.instanceId)) pinned.add(paneId);
  }
  return pinned;
}

/** Pins with this pane's pin added, or every pin on its id removed. */
export function togglePin(pins: readonly string[], pane: Occupied): string[] {
  const others = pins.filter((pin) => split(pin).paneId !== pane.paneId);
  return pinnedPanes(pins, [pane]).has(pane.paneId) ? others : [...others, pinFor(pane)];
}

/**
 * The pins worth keeping, given the session a computer just sent: none for a
 * pane that has closed or that another program now holds, and a pin from
 * before occupants were named takes the occupant it is on now. The same array
 * when nothing changed, so a caller can skip saving it.
 */
export function retainPins(pins: readonly string[], session: Snapshot): readonly string[] {
  if (!session.version) return pins;
  const byId = new Map(session.panes.map((pane) => [pane.paneId, pane]));
  const kept: string[] = [];
  for (const pin of pins) {
    const { paneId, instanceId } = split(pin);
    const pane = byId.get(paneId);
    if (!pane || !sameOccupant(instanceId, pane.instanceId)) continue;
    const next = pane.instanceId ? pinFor(pane) : pin;
    if (!kept.includes(next)) kept.push(next);
  }
  return kept.length === pins.length && kept.every((pin, i) => pin === pins[i]) ? pins : kept;
}
