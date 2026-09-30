import { expect, test } from "bun:test";
import { relativeTime } from "./relative-time";

test("ages read the way a person would say them", () => {
  const t = 1_000_000_000;
  expect(relativeTime(t - 5_000, t)).toBe("just now");
  expect(relativeTime(t - 300_000, t)).toBe("5m ago");
  expect(relativeTime(t - 3 * 3_600_000, t)).toBe("3h ago");
  expect(relativeTime(t - 2 * 86_400_000, t)).toBe("2d ago");
});
