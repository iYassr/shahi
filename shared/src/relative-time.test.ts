import { expect, test } from "bun:test";
import { relativeTime, rowTime } from "./relative-time";

test("ages read the way a person would say them", () => {
  const t = 1_000_000_000;
  expect(relativeTime(t - 5_000, t)).toBe("just now");
  expect(relativeTime(t - 300_000, t)).toBe("5m ago");
  expect(relativeTime(t - 3 * 3_600_000, t)).toBe("3h ago");
  expect(relativeTime(t - 2 * 86_400_000, t)).toBe("2d ago");
});

test("a row's time is short, and turns into a day once the hours stop helping", () => {
  // Local times, so the test reads the same in any time zone.
  const now = new Date(2026, 9, 1, 14, 30).getTime(); // Thu Oct 1, 14:30
  expect(rowTime(now - 20_000, now)).toBe("now");
  expect(rowTime(now - 5 * 60_000, now)).toBe("5m");
  expect(rowTime(new Date(2026, 9, 1, 2, 0).getTime(), now)).toBe("12h");
  expect(rowTime(new Date(2026, 8, 30, 20, 0).getTime(), now)).toBe("Yesterday");
  expect(rowTime(new Date(2026, 8, 28, 9, 0).getTime(), now)).toBe("Mon");
  expect(rowTime(new Date(2026, 8, 20, 9, 0).getTime(), now)).toBe("Sep 20");
  expect(rowTime(new Date(2025, 8, 20, 9, 0).getTime(), now)).toBe("Sep 20, 2025");
});

test("a few hours stay hours across midnight", () => {
  const now = new Date(2026, 9, 1, 1, 0).getTime();
  expect(rowTime(new Date(2026, 8, 30, 23, 0).getTime(), now)).toBe("2h");
});
