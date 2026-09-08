import { type ControlHandshake, type ReleaseChannel, updateInProgress } from "./compatibility";
export interface ControlApi {
  control(): Promise<ControlHandshake | null>;
  updateComputer(action: "check" | "install", channel?: ReleaseChannel): Promise<unknown>;
}
/** One poller per computer; late responses cannot change a different computer. */
export class ControlSession {
  handshake: ControlHandshake | null = null;
  error: string | null = null;
  pending = false;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  constructor(private api: ControlApi, private changed: () => void, private recovered: () => void) {}
  start() { if (!this.stopped) return; this.stopped = false; void this.refresh(); }
  stop() { this.stopped = true; if (this.timer !== undefined) clearTimeout(this.timer); }
  async refresh() {
    if (this.stopped || this.reading) return;
    this.reading = true; if (this.timer !== undefined) clearTimeout(this.timer);
    try {
      const next = await this.api.control();
      if (this.stopped) return;
      const previous = this.handshake;
      this.handshake = next; this.error = null;
      if (previous && next && (previous.backend.state !== "connected" && next.backend.state === "connected" || previous.buildId !== next.buildId)) this.recovered();
    } catch (e) { if (!this.stopped) this.error = e instanceof Error ? e.message : "Cannot reach this computer."; }
    finally {
      this.reading = false;
      if (!this.stopped) {
        this.changed();
        this.timer = setTimeout(() => void this.refresh(), this.pending || this.error || this.handshake && (updateInProgress(this.handshake.update.phase) || this.handshake.backend.state !== "connected") ? 2_000 : 30_000);
      }
    }
  }
  async request(action: "check" | "install", channel?: ReleaseChannel) {
    if (this.pending || this.stopped) return;
    this.pending = true; this.error = null; this.changed();
    try { await this.api.updateComputer(action, channel); }
    catch (e) { if (!this.stopped) this.error = e instanceof Error ? e.message : "Cannot start the update."; }
    finally {
      if (!this.stopped) {
        // The independent manager picks up the durable request once a second.
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.pending = false; void this.refresh(); }, 2_000);
        this.changed();
      }
    }
  }
}

export function controlMessage(h: ControlHandshake): string {
  const u = h.update;
  if (updateInProgress(u.phase)) return ({ checking: "Checking for updates…", downloading: "Downloading computer update…", verifying: "Verifying computer update…", restarting: "Restarting Shahi · reconnecting automatically…" } as Record<string, string>)[u.phase]!;
  if (h.backend.state !== "connected") return h.backend.message;
  if (u.message) return u.message;
  if (u.available) return "A tested update is ready. Shahi will reconnect automatically.";
  return "Connected";
}
