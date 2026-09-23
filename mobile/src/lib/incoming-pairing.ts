/**
 * A pairing code that arrived as a link, held until the person confirms or
 * cancels it.
 *
 * `shahi://pair#…` reaches the app from the iPhone Camera, a tapped message or
 * a terminal. Only the Connect screen used to read it, through its own
 * `useURL()`, so with any computer saved (Connect redirects to the dashboard
 * or the chooser) the link was dropped without a word (pre-release review).
 * It is held here instead, above the router: `app/+native-intent.tsx` puts it
 * here as the link arrives and routes to Connect, and Connect shows the
 * confirm card for as long as it is held, whatever else is saved or open.
 */
import { useSyncExternalStore } from "react";
import type { PairingPayload } from "@shahi/shared";
import { parsePairingUrl } from "./pairing";

let pending: PairingPayload | null = null;
const listeners = new Set<() => void>();
const publish = (next: PairingPayload | null) => { pending = next; listeners.forEach(fn => fn()); };

/** Holds the code if `url` is a pairing link; says whether it was one. */
export function receivePairingLink(url: string): boolean {
  const payload = parsePairingUrl(url);
  if (payload) publish(payload);
  return payload !== null;
}

/** Paired, or cancelled: the link has been answered. */
export function dismissPairing(): void {
  if (pending) publish(null);
}

export function usePendingPairing(): PairingPayload | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => pending,
  );
}
