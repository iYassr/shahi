import { clearNativeDrafts, forgetNativeDraft } from "./drafts";
import { forgetPaneMemory } from "./reader-memory";
import { reconcileSession } from "./session-reconcile";
import { endedPanes, promptAnswered, promptPushed, promptsFromSession, retainReviews, reviewKey, type AnsweredPrompt, type Reviewed, type DashboardPane, type ParsedPrompt, type PromptState, type Session, type SocketMessage } from "@shahi/shared";
import { createApi, SessionSocket, UnauthorizedError, IncompatibleServerError, type Connection, type LinkState } from "./api";
import { deviceTarget, closeRelay, relayLink } from "./relay";
import { openTunnel, closeTunnel } from "./tunnel";
import { renewPushRegistration } from "./push-registration";
import type { SavedComputer } from "./computers";
import { ControlSession } from "@shahi/shared";

/** One independently reconnecting computer. Switching views never disposes it. */
export class ComputerSession {
  readonly connection: Connection;
  readonly api;
  readonly control;
  session: Session | null = null;
  /** The last session from a real snapshot, for `endedPanes`; `session` keeps whatever came. */
  private lastSnapshot: Session | null = null;
  serverId?: string;
  prompts: Record<string, ParsedPrompt> = {};
  /** Questions answered from this phone on panes still waiting (see `promptsFromSession`). */
  answered: Record<string, AnsweredPrompt> = {};
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
  /** The SSH session cookie a saved notification opt-in was last carried to. */
  private pushCookie: string | null = null;
  /**
   * The server answered 426. Held until a request succeeds, because nothing
   * else here is evidence the versions agree: the relay attaches its stream on
   * the first sealed frame with no version check, and the pre-release review
   * found a pushed dashboard wiping "Update needed" into a LIVE agent list.
   */
  private incompatible = false;
  private frames = new Map<string, Set<() => void>>();
  private checking: Promise<void> | null = null;
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
      if (this.saved.connection.kind === "ssh") {
        if (!this.connection.baseUrl) {
          const baseUrl = await openTunnel(this.saved.connection.ssh);
          // Signed out while it opened: nobody else will close this forward.
          if (this.disposed) { void closeTunnel(baseUrl); return; }
          this.connection.baseUrl = baseUrl;
          await this.api.login(this.saved.connection.ssh.passcode, () => !this.disposed);
        }
        // Also for a connection adopted from Connect, so a notification can
        // name this computer from its first launch. Recovery remains
        // reachable across an ordinary API mismatch.
        try { this.serverId = (await this.api.meta()).serverId; } catch (e) { if (!(e instanceof IncompatibleServerError)) throw e; }
        // Each new session, Connect's included, takes over this phone's saved
        // notification opt-in: the server ends a passcode session's
        // registrations when it expires, and SSH signs in afresh on every
        // launch and reconnect.
        if (this.connection.cookie && this.connection.cookie !== this.pushCookie) {
          this.pushCookie = this.connection.cookie;
          void renewPushRegistration(this.saved.connection, this.api, () => !this.disposed);
        }
      }
      if (this.disposed) return;
      this.control.start();
      if (!this.socket) {
        this.socket = new SessionSocket(msg => this.message(msg), state => {
          if (this.disposed) return;
          this.socketLink = state;
          if (this.incompatible) return;
          const different = this.link !== state;
          this.link = state; if (different) this.changed();
          if (state === "live") void this.refresh();
        }, () => { void this.unauthorized(); }, () => { if (!this.disposed) void this.refresh(); }, this.connection);
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
      if (this.disposed || (received !== this.received && !this.incompatible)) return;
      this.incompatible = false;
      this.message({ type: "session", session });
    } catch (e) {
      // A newer frame makes an older failure moot — but not a 426: that frame
      // came from the server this app cannot speak with.
      if (e instanceof IncompatibleServerError || received === this.received) this.failure(e);
    }
  }
  private failure(e: unknown) {
    if (this.disposed) return;
    if (e instanceof UnauthorizedError) { void this.unauthorized(); return; }
    this.error = e as Error;
    this.link = "lost";
    if (e instanceof IncompatibleServerError) { this.incompatible = true; this.socket?.close(); }
    this.changed();
  }
  private message(msg: SocketMessage) {
    if (this.disposed || this.incompatible) return;
    this.updatedAt = Date.now();
    if (msg.type === "session") {
      this.received++;
      this.link = this.socketLink;
      // Background computers receive dashboards without subscribing to a pane.
      const unchanged = this.error === null && JSON.stringify(this.session) === JSON.stringify(msg.session);
      if (unchanged) { this.changed(false); return; }
      // herdr reuses pane ids. A pane that closed or changed hands takes its
      // draft, uncertain send and remembered conversation with it, before any
      // screen renders the new list (see `pane-instance.ts` in @shahi/shared).
      for (const paneId of endedPanes(this.lastSnapshot, msg.session)) {
        forgetNativeDraft(this.api, paneId);
        forgetPaneMemory(this.api, paneId);
      }
      // An agent that quit leaves its shell in the same terminal, so the
      // occupant is unchanged, but its conversation is over: kept, it opened
      // every time over a composer that now runs commands (pre-release bug
      // hunt). Only what the reader remembers goes; a draft stays with the
      // person, and the composer says it runs a command.
      const agents = new Set(this.lastSnapshot?.panes.filter((pane) => pane.isAgent).map((pane) => pane.paneId));
      for (const pane of msg.session.panes) if (!pane.isAgent && agents.has(pane.paneId)) forgetPaneMemory(this.api, pane.paneId);
      if (msg.session.version) this.lastSnapshot = msg.session;
      this.session = reconcileSession(this.session, msg.session); this.error = null;
      this.reviewed = retainReviews(this.reviewed, msg.session.panes);
      this.setPrompts(promptsFromSession(msg.session.panes, this.promptState()));
    } else if (msg.type === "prompt") this.setPrompts(promptPushed(this.promptState(), msg.paneId, msg.prompt));
    else if (msg.type === "frame") {
      this.setPrompts(promptPushed(this.promptState(), msg.frame.paneId, msg.frame.prompt));
      this.frames.get(msg.frame.paneId)?.forEach(fn => fn());
    } else if (msg.type === "log_changed") this.frames.get(msg.paneId)?.forEach(fn => fn());
    this.changed();
  }
  markReviewed(pane: DashboardPane) { if (pane.status === "done") { this.reviewed = { ...this.reviewed, [pane.paneId]: reviewKey(pane) }; this.changed(); } }
  /**
   * The card for `id` answered `shown` (`sent`), or found the question already
   * gone (`closed`): either way it is not offered again while the pane waits.
   */
  answeredPrompt(id: string, shown: ParsedPrompt | undefined, outcome: AnsweredPrompt["outcome"]) {
    this.setPrompts(promptAnswered(this.promptState(), id, shown, outcome)); this.changed();
  }
  private promptState(): PromptState { return { prompts: this.prompts, answered: this.answered }; }
  private setPrompts(state: PromptState) { this.prompts = state.prompts; this.answered = state.answered; }
  watch(id: string | null) { this.watched = id; this.socket?.watch(id); }
  onPaneFrame(id: string, fn: () => void) {
    let set = this.frames.get(id); if (!set) { set = new Set(); this.frames.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.frames.delete(id); };
  }
  /**
   * A request was refused with a 401. Whether that means this computer's
   * access has ended is decided here, where the sign-in state is known, and
   * not by the screen that happened to see it.
   *
   * A relay link is its device, so a 401 there is a revocation. An SSH
   * computer signs in again with its saved passcode after every new tunnel,
   * and a reader poll sent during that login carries no cookie: the
   * pre-release review reproduced such a 401 erasing the saved computer, SSH
   * password and key included. So while a sign-in is in flight, or none has
   * produced a cookie, a 401 says nothing about access. Otherwise the cookie
   * held now is asked about directly, because a 401 can still belong to a
   * request sent before that cookie existed.
   */
  unauthorized(): Promise<void> {
    this.checking ??= this.checkAccess().finally(() => { this.checking = null; });
    return this.checking;
  }
  private async checkAccess() {
    if (this.disposed) return;
    if (this.saved.connection.kind === "ssh") {
      if (this.work || !this.connection.cookie) return;
      const held = this.connection.cookie;
      const status = await this.api.authStatus().catch(() => null);
      // Unreachable or undecided is not evidence; the next request asks again.
      if (!status || status.authenticated || this.disposed || this.connection.cookie !== held) return;
    }
    this.expired();
  }
  async reconnect() {
    if (this.disposed) return;
    if (this.connection.relay) relayLink(this.connection.relay).reconnect();
    // A reconnect already under way is joined, not restarted: closing its
    // tunnel mid-login would fail the very attempt being waited for.
    if (this.saved.connection.kind === "ssh" && this.link !== "live" && !this.work) {
      this.socket?.close(); this.socket = null;
      void closeTunnel(this.connection.baseUrl);
      this.connection.baseUrl = ""; this.connection.cookie = null;
    }
    await this.start();
  }
  dispose() {
    clearNativeDrafts(this.api);
    this.disposed = true; this.socket?.close(); this.frames.clear();
    this.control.stop();
    if (this.connection.relay) closeRelay(this.connection.relay);
    // Only this session's own forward. A replacement session for the same
    // computer adopted a different one, and it is that session's to close.
    if (this.saved.connection.kind === "ssh") void closeTunnel(this.connection.baseUrl);
  }
}
