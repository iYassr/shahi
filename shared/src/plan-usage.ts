/**
 * How much of each agent's subscription is used, as `/api/plan-usage` reports
 * it (capability `plan-usage`). Claude Code's comes from the status line Shahi
 * installs when the person turns it on; Codex's from its own rollouts.
 */

/** One rate-limit window: "5-hour", "Weekly", "Spend limit". */
export interface PlanWindow {
  label: string;
  /** 0 to 100; a spend limit can pass 100. */
  usedPercent: number;
  /** Epoch milliseconds, or null when the agent did not say. */
  resetsAt: number | null;
}

/** The last reading an agent gave, and when. */
export interface ProviderUsage {
  observedAt: number;
  windows: PlanWindow[];
  /** Codex names the plan ("plus", "pro"); Claude Code's input does not. */
  plan?: string;
}

export interface PlanUsage {
  claude: { enabled: boolean; usage: ProviderUsage | null };
  codex: { usage: ProviderUsage | null };
  checkedAt: number;
}

/** A window's name from its length: Codex says 300 and 10080 minutes. */
export function planWindowLabel(minutes: number | null): string {
  if (minutes === null) return "Limit";
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * What to show for a window now. A reading from before the window reset says
 * nothing about the new window, so its percentage is withheld rather than
 * shown as current: the agents only report again after their next reply.
 */
export function planWindowNow(window: PlanWindow, now = Date.now()): { percent: number | null; reset: string | null } {
  if (window.resetsAt !== null && window.resetsAt <= now) return { percent: null, reset: "Reset since the last reading" };
  return { percent: Math.max(0, Math.round(window.usedPercent)), reset: window.resetsAt === null ? null : `Resets ${resetTime(window.resetsAt, now)}` };
}

/** "4:20 PM" today, "Thu 9:00 AM" this week, "Oct 8" further out. */
function resetTime(at: number, now: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === when.toDateString();
  if (sameDay) return time;
  if (at - now < 6 * 86_400_000) return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
