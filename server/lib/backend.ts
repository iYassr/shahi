import type { BackendState } from "@shahi/shared";
import { HERDR_PROTOCOL } from "./herdr-schema";

/**
 * The herdr releases this build was tested against. Each has a pinned live job
 * in CI, and release.json names them for update managers from 0.3.29 and
 * earlier, which install only a release that lists the computer's exact herdr.
 * The list is not the gate: herdrCompatibility is.
 */
export const HERDR_SUPPORT = [
  { version: "0.9.0", protocol: 22 },
  { version: "0.9.1", protocol: 22 },
  { version: "0.9.2", protocol: 22 },
  { version: "0.9.3", protocol: 22 },
  { version: "0.9.4", protocol: 22 },
  { version: "0.9.5", protocol: 22 },
] as const;

/**
 * herdr's protocol number is its own promise about its API, so the protocol is
 * what decides, not the version. This used to enable the adapter only for the
 * exact versions above: herdr 0.9.4 and 0.9.5 (13 and 14 October 2026) kept
 * protocol 22, and every computer that updated herdr refused all its agents
 * with "This herdr release needs a tested Shahi adapter" until Shahi shipped a
 * release naming them, though the agent journeys passed against 0.9.5 on both
 * test computers. A newer protocol is tried too, since herdr's protocol bumps
 * have been additive; one that is not shows up as a session this build cannot
 * read, which BackendMonitor reports as needing a Shahi update.
 */
export function herdrCompatibility(version: string, protocol: number): BackendState {
  if (protocol >= HERDR_PROTOCOL) return { state: "connected", version, protocol };
  return {
    state: "update-required", version, protocol,
    message: "Update herdr on this computer to continue. Shahi keeps your pairing. Updating herdr may interrupt running sessions.",
  };
}

/** A newer herdr that answers but whose session this build cannot read. */
function beyondAdapter(pong: { version: string; protocol: number }): BackendState {
  return {
    state: "service-update-required", version: pong.version, protocol: pong.protocol,
    message: `herdr ${pong.version} changed in a way this version of Shahi can't read yet. Check for a computer update. Your pairing is saved.`,
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
    // Carries what herdr answered, so a newer herdr is not called offline.
    if (!snapshot.lastSyncOk) throw Object.assign(new Error("herdr snapshot unavailable"), { pong });
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
    let pong: { version: string; protocol: number } | undefined;
    try {
      pong = await this.probe();
      if (this.stopped) return;
      const next = herdrCompatibility(pong.version, pong.protocol);
      if (next.state === "connected" && previous !== "connected") await this.start();
      if (!this.stopped) this.state = next;
    } catch (err) {
      // It answered ping, so it is running: a snapshot a newer protocol cannot
      // be read from is a change this build does not understand.
      const answered = pong ?? (err as { pong?: { version: string; protocol: number } }).pong;
      this.state = answered && answered.protocol > HERDR_PROTOCOL
        ? beyondAdapter(answered)
        : { state: "offline", message: "herdr is offline. Shahi will reconnect automatically." };
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
