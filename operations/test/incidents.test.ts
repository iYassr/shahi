import { expect, test } from "bun:test";
import { advance, notification } from "../src/incidents";
test("three consecutive failures fire, two recover, and hourly reminders are deduplicated", () => {
  let s = advance(undefined, false);
  s = advance(s, false);
  expect(notification(s, 1000)).toBeNull();
  s = advance(s, true); s = advance(s, false);
  expect(s.failures).toBe(1);
  s = advance(advance(s, false), false);
  expect(notification(s, 1000)).toBe("firing");
  // A failed delivery does not advance notified/lastSent, so it is retried.
  expect(notification(s, 2000)).toBe("firing");
  s.notified = true; s.lastSent = 2000;
  expect(notification(s, 3000)).toBeNull();
  expect(notification(s, 3602000)).toBe("firing");
  s = advance(s, true);
  expect(notification(s, 4000)).toBeNull();
  s = advance(s, true);
  expect(notification(s, 4000)).toBe("recovered");
  s.notified = false;
  expect(notification(s, 5000)).toBeNull();
});
