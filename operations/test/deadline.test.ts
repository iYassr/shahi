import { expect, test } from "bun:test";
import { withDeadline } from "../src/deadline";
import { hotspotChecks, MAX_ALARMS_PER_OBJECT_HOUR, MAX_MESSAGES_PER_OBJECT_HOUR } from "../src/hotspots";

test("a finished check leaves no timer behind to keep the monitor's object awake", async () => {
  // AbortSignal.timeout held the object for 15 s after every half-second check.
  const pending = new Set<unknown>();
  const [set, clear] = [globalThis.setTimeout, globalThis.clearTimeout];
  globalThis.setTimeout = ((fn: () => void, ms: number) => { const t = set(fn, ms); pending.add(t); return t; }) as typeof setTimeout;
  globalThis.clearTimeout = ((t: ReturnType<typeof setTimeout>) => { pending.delete(t); clear(t); }) as typeof clearTimeout;
  try {
    expect(await withDeadline(15_000, async () => "ok")).toBe("ok");
    await expect(withDeadline(15_000, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(pending.size).toBe(0);
  } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
});

test("a check that outlives its deadline is aborted", async () => {
  const aborted = withDeadline(10, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  await expect(aborted).rejects.toThrow("timeout");
});

test("hot spots flag a runaway object and never read missing counts as healthy", () => {
  expect(hotspotChecks({ maxAlarmsPerObject: 26, maxMessagesPerObject: 22_828 })).toEqual({ relay_alarm_loop: true, relay_message_storm: true });
  // The September storm: about 45,000 alarms an hour on one object.
  expect(hotspotChecks({ maxAlarmsPerObject: 45_000, maxMessagesPerObject: 0 }).relay_alarm_loop).toBe(false);
  // The relay's alarm floor caps a loop at 360 an hour, which must still be caught.
  expect(hotspotChecks({ maxAlarmsPerObject: 360, maxMessagesPerObject: 0 }).relay_alarm_loop).toBe(false);
  expect(hotspotChecks({ maxAlarmsPerObject: MAX_ALARMS_PER_OBJECT_HOUR, maxMessagesPerObject: MAX_MESSAGES_PER_OBJECT_HOUR + 1 }))
    .toEqual({ relay_alarm_loop: true, relay_message_storm: false });
  for (const bad of [null, {}, { maxAlarmsPerObject: "1", maxMessagesPerObject: 0 }, { maxAlarmsPerObject: NaN, maxMessagesPerObject: 0 }, { eventsByKind: {} }]) {
    expect(() => hotspotChecks(bad)).toThrow();
  }
});
