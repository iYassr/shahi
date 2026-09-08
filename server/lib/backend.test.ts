import { expect, test } from "bun:test";
import { BackendMonitor, herdrCompatibility } from "./backend";
test("herdr adapter accepts only release-tested combinations", () => {
  expect(herdrCompatibility("0.9.0", 22).state).toBe("connected");
  expect(herdrCompatibility("0.8.2", 20).state).toBe("update-required");
  expect(herdrCompatibility("0.10.0", 23).state).toBe("service-update-required");
});
test("backend failure and recovery do not restart the connection service", async () => {
  let offline = true, starts = 0, stops = 0;
  const m = new BackendMonitor(async () => { if (offline) throw new Error("down"); return { version: "0.9.0", protocol: 22 }; }, async () => { starts++; }, () => { stops++; });
  await m.check(); expect(m.state.state).toBe("offline"); expect(starts).toBe(0);
  offline = false; await m.check(); await m.check(); expect(starts).toBe(1);
  offline = true; await m.check(); expect(stops).toBe(2);
  offline = false; await m.check(); expect(starts).toBe(2); m.close();
});
test("does not announce Connected before the first usable snapshot", async () => {
  let finish!: () => void;
  const monitor = new BackendMonitor(async () => ({ version: "0.9.0", protocol: 22 }), () => new Promise(resolve => { finish = resolve; }), () => {});
  const check = monitor.check(); await Promise.resolve();
  expect(monitor.state.state).toBe("offline"); finish(); await check;
  expect(monitor.state.state).toBe("connected"); monitor.close();
});
