import { type ControlHandshake, type ReleaseChannel, updateInProgress } from "./compatibility";
import { translate, type AppLocale } from "./i18n";
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

/** Said in Settings only: a development checkout or a hand-run sidecar works, and has nothing to act on. */
export const UNMANAGED_MESSAGE = "Computer updates need the managed Shahi service: install Shahi on this computer with herdr plugin install iYassr/shahi.";

export function controlMessage(h: ControlHandshake, locale: AppLocale = "en"): string {
  const t = (source: string) => translate(locale, source);
  const u = h.update;
  if (updateInProgress(u.phase)) return t(({ checking: "Checking for updates…", downloading: "Downloading computer update…", verifying: "Verifying computer update…", restarting: "Restarting Shahi · reconnecting automatically…" } as Record<string, string>)[u.phase]!);
  if (h.backend.state !== "connected") return t(h.backend.message);
  if (u.message) return t(u.message);
  if (u.available) return t("A tested update is ready. Shahi will reconnect automatically.");
  if (!u.managed) return t(UNMANAGED_MESSAGE);
  return t("Connected");
}

/**
 * Whether the card belongs outside Settings: something is happening, needs
 * doing, or went wrong. An unmanaged computer's notice is none of those, and
 * older servers still send it as a message, so a message counts only from a
 * managed install; the card with that notice could not be dismissed from the
 * Agents list or any conversation (compatibility bug hunt).
 *
 * herdr merely stopped is not one either: the connection banner says so,
 * beside every other reason nothing can be done, and the card said it a
 * second time (pre-release bug hunt).
 *
 * Nor is a read that failed because the computer cannot be reached, while
 * the connection card is saying exactly that (`linkDown`). Build 32 showed an
 * offline computer four times over on the Agents list, this card's "Computer
 * unavailable. Your pairing is saved." with the transport's words beneath it
 * among them. An update under way still says so: the computer is away
 * because it is restarting, which the connection card cannot know.
 */
export function controlNeedsAttention(h: ControlHandshake, control: { pending: boolean; error: string | null }, linkDown = false): boolean {
  if (linkDown && control.error && !control.pending && !updateInProgress(h.update.phase)) return false;
  const backendNews = h.backend.state !== "connected" && h.backend.state !== "offline";
  return control.pending || !!control.error || updateInProgress(h.update.phase) || backendNews || !!h.update.available || (h.update.managed && !!h.update.message);
}
