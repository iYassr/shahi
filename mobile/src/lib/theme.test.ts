import { statusColor } from "./theme";

it("keeps activity, completion, attention, and idle visually distinct", () => {
  expect(statusColor("working")).toBe("#8BB8E8");
  expect(statusColor("done")).toBe("#5FB88A");
  expect(statusColor("blocked")).toBe("#E8A33D");
  expect(statusColor("idle")).toBe("#A6A099");
  expect(statusColor("exited")).toBe("#D96A4A");
  expect(statusColor("unknown")).toBe("#A6A099");
});
