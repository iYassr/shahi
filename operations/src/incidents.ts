export interface Incident {
  failures: number; successes: number; firing: boolean; notified: boolean; lastSent: number;
}
export function advance(previous: Incident | undefined, healthy: boolean): Incident {
  const next = { failures: 0, successes: 0, firing: false, notified: false, lastSent: 0, ...previous };
  if (healthy) { next.failures = 0; next.successes++; }
  else { next.successes = 0; next.failures++; }
  if (next.failures >= 3) next.firing = true;
  if (next.successes >= 2) next.firing = false;
  return next;
}
export function notification(state: Incident, now: number): "firing" | "recovered" | null {
  if (state.firing && (!state.notified || now - state.lastSent >= 60 * 60_000)) return "firing";
  if (!state.firing && state.notified) return "recovered";
  return null;
}
