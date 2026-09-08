import { expect, test } from "bun:test";
import { finishUpdate } from "./update";

test("keeps the old service running until installation commits, then verifies the new process", async () => {
  let ticks = 0, restarts = 0;
  await finishUpdate({
    installed: () => ticks >= 2,
    restart: async () => { expect(ticks).toBe(2); restarts++; },
    verified: async () => ticks >= 4,
    sleep: async () => { ticks++; }, attempts: 5,
  });
  expect(restarts).toBe(1);
  expect(ticks).toBe(4);
});
test("failed installation never restarts the existing service", async () => {
  let restarts = 0;
  await expect(finishUpdate({ installed: () => false, restart: async () => { restarts++; },
    verified: async () => true, sleep: async () => {}, attempts: 2,
  })).rejects.toThrow("Installation did not finish");
  expect(restarts).toBe(0);
});
test("an old or unhealthy process cannot count as a successful update", async () => {
  await expect(finishUpdate({ installed: () => true, restart: async () => {},
    verified: async () => false, sleep: async () => {}, attempts: 2,
  })).rejects.toThrow("did not become ready");
});
test("a failed restart reports failure without claiming readiness", async () => {
  let verified = false;
  await expect(finishUpdate({ installed: () => true,
    restart: async () => { throw new Error("restart failed"); },
    verified: async () => { verified = true; return true; },
  })).rejects.toThrow("restart failed");
  expect(verified).toBe(false);
});
