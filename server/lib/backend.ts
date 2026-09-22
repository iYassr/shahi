import type { BackendState } from "@shahi/shared";

/** Only profiles exercised by the release matrix may enable the adapter. */
export const HERDR_SUPPORT = [{ version: "0.9.0", protocol: 22 }, { version: "0.9.1", protocol: 22 }] as const;
export function herdrCompatibility(version: string, protocol: number): BackendState {
  if (HERDR_SUPPORT.some(profile => profile.version === version && profile.protocol === protocol)) {
    return { state: "connected", version, protocol };
  }
  const older = protocol < 22 || /^0\.[0-8]\./.test(version);
  return {
    state: older ? "update-required" : "service-update-required", version, protocol,
    message: older
      ? "Update herdr on this computer to continue. Shahi keeps your pairing. Updating herdr may interrupt running sessions."
      : "This herdr release needs a tested Shahi adapter. Check for a computer update. Your pairing is saved.",
  };
}

/**
 * One probe of herdr: it must answer `ping`, and once connected it must also
 * produce a usable snapshot.
 *
 * `lastSyncOk` is one flag set by whichever snapshot ran last, and a single
 * slow one — the 5s RPC timeout while many agents start — used to fail the
 * probe outright. That took every route to 503 "herdr is offline" and tore the
 * poller and event stream down for a probe cycle or two, while herdr answered
 * ping the whole time (pre-release review). So a failed snapshot is retried
 * here before herdr is called offline; one that fails again still is.
 */
export async function probeHerdr(
  ping: () => Promise<{ version: string; protocol: number }>,
  snapshot: { readonly lastSyncOk: boolean; resync(): Promise<void> },
  connected: () => boolean,
): Promise<{ version: string; protocol: number }> {
  const pong = await ping();
  if (connected() && !snapshot.lastSyncOk) {
    await snapshot.resync();
    if (!snapshot.lastSyncOk) throw new Error("herdr snapshot unavailable");
  }
  return pong;
}

/** Serial probes; a failed backend never takes authentication or recovery down. */
export class BackendMonitor {
  state: BackendState = { state: "offline", message: "Waiting for herdr on this computer." };
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private probe: () => Promise<{ version: string; protocol: number }>, private start: () => Promise<void>, private stop: () => void) {}
  async check() {
    if (this.stopped) return;
    const previous = this.state.state;
    try {
      const pong = await this.probe();
      if (this.stopped) return;
      const next = herdrCompatibility(pong.version, pong.protocol);
      if (next.state === "connected" && previous !== "connected") await this.start();
      if (!this.stopped) this.state = next;
    } catch {
      this.state = { state: "offline", message: "herdr is offline. Shahi will reconnect automatically." };
    }
    if (this.stopped || this.state.state !== "connected") this.stop();
  }
  run() {
    const tick = async () => {
      await this.check();
      if (!this.stopped) this.timer = setTimeout(tick, 3_000);
    };
    void tick();
  }
  close() { this.stopped = true; clearTimeout(this.timer); this.stop(); }
}
