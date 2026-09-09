import { reconcileSession } from "./session-reconcile";
import { retainReviews, reviewKey, type Reviewed, type DashboardPane, type ParsedPrompt, type Session, type SocketMessage } from "@shahi/shared";
import { createApi, SessionSocket, UnauthorizedError, IncompatibleServerError, type Connection, type LinkState } from "./api";
import { deviceTarget, closeRelay, relayLink } from "./relay";
import { openTunnel, closeTunnel } from "./tunnel";
import type { SavedComputer } from "./computers";
import { ControlSession } from "@shahi/shared";

/** One independently reconnecting computer. Switching views never disposes it. */
export class ComputerSession {
  readonly connection: Connection;
  readonly api;
  readonly control;
  session: Session | null = null;
  serverId?: string;
  prompts: Record<string, ParsedPrompt> = {};
  reviewed: Reviewed = {};
  link: LinkState = "connecting";
  error: Error | null = null;
  updatedAt: number | null = null;
  socket: SessionSocket | null = null;
  private disposed = false;
  private watched: string | null = null;
  private work: Promise<void> | null = null;
  private socketLink: LinkState = "connecting";
  private received = 0;
  private frames = new Map<string, Set<() => void>>();
  constructor(public saved: SavedComputer, private changed: (visible?: boolean) => void, private expired: () => void, adopted?: Connection) {
    this.connection = adopted ?? { baseUrl: "", cookie: null, relay: saved.connection.kind === "relay" ? deviceTarget(saved.connection) : null };
    this.api = createApi(this.connection);
    this.control = new ControlSession(this.api, () => {
      if (this.disposed) return;
      this.serverId = this.control.handshake?.serverId ?? this.serverId;
      this.changed();
    }, () => { void this.start(); });
  }
  async start() {
    if (this.disposed || this.work) return this.work;
    this.work = this.connect();
    try { await this.work; } finally { this.work = null; }
  }
  private async connect() {
    try {
      if (this.saved.connection.kind === "ssh" && !this.connection.baseUrl) {
        this.connection.baseUrl = await openTunnel(this.saved.connection.ssh);
        if (this.disposed) return;
        await this.api.login(this.saved.connection.ssh.passcode, () => !this.disposed);
        // Recovery remains reachable across an ordinary API mismatch.
        try { this.serverId = (await this.api.meta()).serverId; } catch (e) { if (!(e instanceof IncompatibleServerError)) throw e; }
      }
      if (this.disposed) return;
      this.control.start();
      if (!this.socket) {
        this.socket = new SessionSocket(msg => this.message(msg), state => {
          if (this.disposed) return;
          this.socketLink = state;
          const different = this.link !== state;
          this.link = state; if (different) this.changed();
          if (state === "live") void this.refresh();
        }, () => { if (!this.disposed) this.expired(); }, () => { if (!this.disposed) void this.refresh(); }, this.connection);
        this.socket.connect();
        this.socket.watch(this.watched);
      } else this.socket.ensureConnected();
      await this.refresh();
    } catch (e) { this.failure(e); }
  }
  async refresh() {
    const received = this.received;
    try {
      const session = await this.api.session();
      if (!this.disposed && received === this.received) this.message({ type: "session", session });
    } catch (e) { if (received === this.received) this.failure(e); }
  }
  private failure(e: unknown) {
    if (this.disposed) return;
    if (e instanceof UnauthorizedError) { this.expired(); return; }
    this.error = e as Error;
    this.link = "lost";
    if (e instanceof IncompatibleServerError) this.socket?.close();
    this.changed();
  }
  private message(msg: SocketMessage) {
    if (this.disposed) return;
    this.updatedAt = Date.now();
    if (msg.type === "session") {
      this.received++;
      this.link = this.socketLink;
      // Background computers receive dashboards without subscribing to a pane.
      const unchanged = this.error === null && JSON.stringify(this.session) === JSON.stringify(msg.session);
      if (unchanged) { this.changed(false); return; }
      this.session = reconcileSession(this.session, msg.session); this.error = null;
      this.reviewed = retainReviews(this.reviewed, msg.session.panes);
      const next: Record<string, ParsedPrompt> = {};
      for (const pane of msg.session.panes) if (pane.status === "blocked" && (this.prompts[pane.paneId] ?? pane.prompt)) next[pane.paneId] = (this.prompts[pane.paneId] ?? pane.prompt)!;
      this.prompts = next;
    } else if (msg.type === "prompt") this.prompts = { ...this.prompts, [msg.paneId]: msg.prompt };
    else if (msg.type === "frame") {
      if (msg.frame.prompt) this.prompts = { ...this.prompts, [msg.frame.paneId]: msg.frame.prompt };
      this.frames.get(msg.frame.paneId)?.forEach(fn => fn());
    } else if (msg.type === "log_changed") this.frames.get(msg.paneId)?.forEach(fn => fn());
    this.changed();
  }
  markReviewed(pane: DashboardPane) { if (pane.status === "done") { this.reviewed = { ...this.reviewed, [pane.paneId]: reviewKey(pane) }; this.changed(); } }
  clearPrompt(id: string) { const next = { ...this.prompts }; delete next[id]; this.prompts = next; this.changed(); }
  watch(id: string | null) { this.watched = id; this.socket?.watch(id); }
  onPaneFrame(id: string, fn: () => void) {
    let set = this.frames.get(id); if (!set) { set = new Set(); this.frames.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.frames.delete(id); };
  }
  async reconnect() {
    if (this.disposed) return;
    if (this.connection.relay) relayLink(this.connection.relay).reconnect();
    if (this.saved.connection.kind === "ssh" && this.link !== "live") {
      this.socket?.close(); this.socket = null; this.connection.baseUrl = ""; this.connection.cookie = null;
    }
    await this.start();
  }
  dispose() {
    this.disposed = true; this.socket?.close(); this.frames.clear();
    this.control.stop();
    if (this.connection.relay) closeRelay(this.connection.relay);
    if (this.saved.connection.kind === "ssh") void closeTunnel(this.saved.connection.ssh);
  }
}
