import { describe, expect, test } from "bun:test";
import { BackendMonitor, herdrCompatibility, probeHerdr } from "./backend";
// herdr 0.9.4 and 0.9.5 kept protocol 22 and were refused for not being on a
// list of versions; every computer that updated herdr lost its agents.
test("a herdr release on the same protocol connects, whatever its version", () => {
  for (const version of ["0.9.0", "0.9.3", "0.9.4", "0.9.5", "0.9.17", "0.10.0"]) expect(herdrCompatibility(version, 22).state).toBe("connected");
});
test("a newer protocol is tried, and an older one asks for a herdr update", () => {
  expect(herdrCompatibility("0.10.0", 23).state).toBe("connected");
  expect(herdrCompatibility("0.8.2", 20)).toMatchObject({ state: "update-required", message: expect.stringContaining("Update herdr") });
});
test("a newer herdr whose session cannot be read asks for a Shahi update, not for herdr to start", async () => {
  let protocol = 23;
  const monitor = new BackendMonitor(async () => ({ version: "0.10.0", protocol }), async () => { throw new Error("herdr snapshot unavailable"); }, () => {});
  await monitor.check();
  expect(monitor.state).toMatchObject({ state: "service-update-required", version: "0.10.0", message: expect.stringContaining("Check for a computer update") });
  // The same failure on the protocol this build speaks is herdr not answering properly, not a change.
  protocol = 22; await monitor.check();
  expect(monitor.state.state).toBe("offline");
  monitor.close();
});
test("a connected herdr replaced by a newer one Shahi cannot read is not called offline", async () => {
  let pong = { version: "0.9.5", protocol: 22 };
  const store = { lastSyncOk: true, async resync() { store.lastSyncOk = pong.protocol === 22; } };
  const monitor = new BackendMonitor(() => probeHerdr(async () => pong, store, () => monitor.state.state === "connected"), async () => {}, () => {});
  await monitor.check();
  expect(monitor.state.state).toBe("connected");
  pong = { version: "0.10.0", protocol: 23 }; store.lastSyncOk = false;
  await monitor.check();
  expect(monitor.state).toMatchObject({ state: "service-update-required", version: "0.10.0" });
  monitor.close();
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

/**
 * One slow `session.snapshot` (the 5s RPC timeout under load) used to fail the
 * probe outright: every route answered 503 "herdr is offline" and the poller
 * and event stream were torn down, though herdr answered ping throughout.
 */
describe("a failed snapshot", () => {
  const pong = async () => ({ version: "0.9.0", protocol: 22 });
  /** A mirror whose snapshots succeed or fail from a script, one entry per attempt. */
  function mirror(results: boolean[]) {
    const store = {
      lastSyncOk: true,
      attempts: 0,
      async resync() {
        store.lastSyncOk = results[store.attempts++] ?? true;
      },
    };
    return store;
  }

  test("does not take a herdr that still answers ping offline", async () => {
    const store = mirror([false, true]);
    let stops = 0;
    const monitor = new BackendMonitor(
      () => probeHerdr(pong, store, () => monitor.state.state === "connected"),
      async () => {},
      () => void stops++,
    );
    await monitor.check();
    expect(monitor.state.state).toBe("connected");

    await store.resync(); // the periodic snapshot times out once
    await monitor.check();

    expect(monitor.state.state).toBe("connected");
    expect(stops).toBe(0);
    monitor.close();
  });

  test("still reports herdr offline when the snapshot keeps failing", async () => {
    const store = mirror([false, false]);
    const monitor = new BackendMonitor(
      () => probeHerdr(pong, store, () => monitor.state.state === "connected"),
      async () => {},
      () => {},
    );
    await monitor.check();
    await store.resync();
    await monitor.check();

    expect(monitor.state.state).toBe("offline");
    monitor.close();
  });
});
