/** "just now", "5m ago", "3h ago", "2d ago": enough to tell recent from forgotten. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const DAY = 86_400_000;
const midnight = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * When a conversation last moved, short enough for the corner of a list row:
 * "now", "5m", "3h", "Yesterday", "Mon", "Sep 28", "Sep 28, 2025". Hours are
 * kept for the last six however the calendar falls, since "2h" reads better
 * than "Yesterday" at one in the morning; past that, the calendar day decides.
 * The audit of build 28 found rows with no time at all, so two conversations
 * from this morning and last month looked equally fresh.
 */
export function rowTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const today = midnight(now);
  if (s < 6 * 3600 || at >= today) return `${Math.floor(s / 3600)}h`;
  if (at >= today - DAY) return "Yesterday";
  const when = new Date(at);
  if (at >= today - 6 * DAY) return when.toLocaleDateString("en-US", { weekday: "short" });
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
