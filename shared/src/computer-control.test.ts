import { expect, test } from "bun:test";
import { ControlSession, controlMessage, controlNeedsAttention, UNMANAGED_MESSAGE } from "./computer-control";
import { supports, type ControlHandshake } from "./compatibility";
const h: ControlHandshake = { control: 1, serverId: "one", buildId: "old", api: { min: 5, max: 5 }, capabilities: ["sessions"], backend: { state: "connected", version: "0.9.0", protocol: 22 }, update: { managed: true, phase: "idle", channel: "stable", current: "0.3.0" } };
test("a late control response cannot restore a removed computer", async () => {
  let resolve!: (h: ControlHandshake) => void, changes = 0;
  const c = new ControlSession({ control: () => new Promise(r => { resolve = r; }), updateComputer: async () => {} }, () => { changes++; }, () => {});
  c.start(); c.stop(); resolve(h); await Promise.resolve(); await Promise.resolve();
  expect(c.handshake).toBeNull(); expect(changes).toBe(0);
});
test("updates stay scoped and a changed running build reconnects once", async () => {
  const writes: string[] = []; let current = h, recovered = 0;
  const a = new ControlSession({ control: async () => current, updateComputer: async () => { writes.push("a"); } }, () => {}, () => { recovered++; });
  const b = new ControlSession({ control: async () => h, updateComputer: async () => { writes.push("b"); } }, () => {}, () => {});
  try {
    a.start(); b.start(); await Promise.resolve(); await Promise.resolve();
    await a.request("install"); expect(writes).toEqual(["a"]);
    current = { ...h, buildId: "new" }; await a.refresh(); await a.refresh(); expect(recovered).toBe(1);
  } finally { a.stop(); b.stop(); }
});
test("absent additive capabilities hide only their own feature", () => {
  expect(supports(h, "attachments")).toBe(false); expect(supports(h, "sessions")).toBe(true);
  expect(supports(null, "attachments")).toBe(true); expect(supports(null, "computer-updates")).toBe(false);
});

// A development checkout's notice sat on the Agents list and in every
// conversation, and could not be dismissed; older servers still send it as a
// message (compatibility bug hunt).
test("an unmanaged computer's notice is not a reason to show the card outside Settings", () => {
  const idle = { pending: false, error: null };
  const unmanaged: ControlHandshake = { ...h, update: { managed: false, phase: "idle", channel: "stable", current: "development" } };
  const olderServer: ControlHandshake = { ...h, update: { ...unmanaged.update, message: "Install the managed Shahi service on this computer to enable app updates." } };
  expect(controlNeedsAttention(unmanaged, idle)).toBe(false);
  expect(controlNeedsAttention(olderServer, idle)).toBe(false);
  expect(controlMessage(unmanaged)).toBe(UNMANAGED_MESSAGE);
  // What still earns a place on every screen.
  expect(controlNeedsAttention({ ...h, update: { ...h.update, message: "The update did not start correctly." } }, idle)).toBe(true);
  expect(controlNeedsAttention({ ...h, update: { ...h.update, available: "0.3.1" } }, idle)).toBe(true);
  expect(controlNeedsAttention({ ...h, backend: { state: "offline", message: "herdr is offline" } }, idle)).toBe(true);
  expect(controlNeedsAttention(h, { pending: false, error: "Cannot reach this computer." })).toBe(true);
  expect(controlNeedsAttention(h, idle)).toBe(false);
});
