import { expect, test } from "bun:test";
import { planWindowLabel, planWindowNow } from "./plan-usage";

test("windows are named by their length", () => {
  expect([300, 10_080, 1440, 90, null].map(planWindowLabel)).toEqual(["5-hour", "Weekly", "1-day", "90-minute", "Limit"]);
});

test("a window shows its percentage until it resets, then says it has reset", () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime();
  const later = new Date(2026, 9, 1, 19, 30).getTime();
  expect(planWindowNow({ label: "5-hour", usedPercent: 23.6, resetsAt: later }, now)).toEqual({
    percent: 24, reset: `Resets ${new Date(later).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
  });
  expect(planWindowNow({ label: "5-hour", usedPercent: 90, resetsAt: now - 1 }, now)).toEqual({ percent: null, reset: "Reset since the last reading" });
  expect(planWindowNow({ label: "Weekly", usedPercent: 5, resetsAt: null }, now)).toEqual({ percent: 5, reset: null });
});
