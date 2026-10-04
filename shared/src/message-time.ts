import { translate, type AppLocale } from "./i18n";
/**
 * When a message was written, as a reader needs it: the time alone today,
 * and the day too otherwise. Reader showed "11:45 AM" on every message, so a
 * reply from last week looked like this morning's (device audit of build 28,
 * October 2026).
 */
export function messageTime(at: number, now = Date.now(), locale: AppLocale = "en"): string {
  const when = new Date(at);
  const dateLocale = locale === "en" ? [] : locale;
  const time = when.toLocaleTimeString(dateLocale, { hour: "numeric", minute: "2-digit" });
  const days = dayNumber(new Date(now)) - dayNumber(when);
  if (days <= 0) return time;
  if (days === 1) return translate(locale, "Yesterday {time}", { time });
  if (days < 7) return `${when.toLocaleDateString(dateLocale, { weekday: "short" })} ${time}`;
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return `${when.toLocaleDateString(dateLocale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

/** Days since the epoch in local time, so "yesterday" follows the clock on the wall, not UTC. */
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}
