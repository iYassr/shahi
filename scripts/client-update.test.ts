import { expect, test } from "bun:test";
import { editClientUpdate } from "./client-update";
const now = Date.parse("2026-09-29T00:00:00Z");
test("the emergency command creates a bounded requirement and can clear it", () => {
  const enabled = editClientUpdate({ schema: 1, ios: null, web: null }, "ios", 28, 24, "Fix Reader", now);
  expect(enabled.ios).toEqual({ minimumBuild: 28, expiresAt: "2026-09-30T00:00:00.000Z", message: "Fix Reader" });
  expect(enabled.web).toBeNull();
  expect(editClientUpdate(enabled, "ios", null).ios).toBeNull();
  for (const hours of [-1, 0, 337, Infinity]) expect(() => editClientUpdate(enabled, "web", 2, hours, "Fix Reader", now)).toThrow();
});
