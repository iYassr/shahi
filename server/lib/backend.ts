import type { BackendState } from "@shahi/shared";

/** Only profiles exercised by the release matrix may enable the adapter. */
export const HERDR_SUPPORT = [{ version: "0.9.0", protocol: 22 }] as const;
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
