import { expect, test } from "bun:test";
import { messageTime } from "./message-time";

const at = (y: number, m: number, d: number, h = 14, min = 27) => new Date(y, m - 1, d, h, min).getTime();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const now = at(2026, 10, 1, 15, 0);

test("a message from today shows only its time", () => {
  expect(messageTime(at(2026, 10, 1, 9, 5), now)).toBe(time(at(2026, 10, 1, 9, 5)));
});

test("a message from last night is yesterday's, by the local calendar", () => {
  expect(messageTime(at(2026, 9, 30, 23, 50), now)).toBe(`Yesterday ${time(at(2026, 9, 30, 23, 50))}`);
});

test("a message from earlier this week names its weekday", () => {
  const sunday = at(2026, 9, 27);
  expect(messageTime(sunday, now)).toBe(`${new Date(sunday).toLocaleDateString([], { weekday: "short" })} ${time(sunday)}`);
});

test("an older message names its date, and its year only when it is not this year's", () => {
  const september = at(2026, 9, 12);
  expect(messageTime(september, now)).toBe(`${new Date(september).toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(september)}`);
  const lastYear = at(2025, 12, 30);
  expect(messageTime(lastYear, now)).toContain("2025");
});
