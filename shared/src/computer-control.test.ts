import { expect, test } from "bun:test";
import { ControlSession } from "./computer-control";
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
