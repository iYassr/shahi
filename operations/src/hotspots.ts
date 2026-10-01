/**
 * Runaway relay objects, read from Cloudflare's own invocation counts so they
 * are caught whatever relay code caused them. In the busiest healthy hour
 * measured 3–29 September 2026 one object ran 26 alarms and 22,828 socket
 * messages. The September alarm storm ran about 45,000 alarms an hour on each
 * of eight objects for a week, and nothing noticed it until the bill.
 */
/** Ten times the healthy peak; the relay's own ALARM_FLOOR_MS caps a loop at 360. */
export const MAX_ALARMS_PER_OBJECT_HOUR = 240;
/** Four times the healthy peak; the phone frame limiter alone allows millions. */
export const MAX_MESSAGES_PER_OBJECT_HOUR = 100_000;

export function hotspotChecks(data: unknown): { relay_alarm_loop: boolean; relay_message_storm: boolean } {
  const { maxAlarmsPerObject: alarms, maxMessagesPerObject: messages } = (data ?? {}) as Record<string, unknown>;
  if (typeof alarms !== "number" || typeof messages !== "number" || !Number.isFinite(alarms) || !Number.isFinite(messages)) throw new Error("invalid hotspots");
  return { relay_alarm_loop: alarms <= MAX_ALARMS_PER_OBJECT_HOUR, relay_message_storm: messages <= MAX_MESSAGES_PER_OBJECT_HOUR };
}
