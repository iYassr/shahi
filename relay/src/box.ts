/**
 * One Durable Object per box: the box's authenticated socket on one side, up
 * to eight phones on the other, and frames forwarded between them with a
 * link number prefixed on the box side. `docs/relay.md`, "What the relay
 * does", is the contract; the shapes and limits come from `shared/`.
 *
 * Every socket is accepted with the hibernation API, so between frames the
 * object is evicted from memory and an idle box costs nothing. That rules out
 * instance fields: the only state that survives is what is attached to each
 * socket (`serializeAttachment`) and the tags it was accepted with. The
 * attachment on the box socket carries the nonce, whether it has proven
 * itself, whether it reports its links' proofs, and the next link number; a
 * phone's carries its link, its token bucket, when it was last heard from and
 * whether the box has vouched for it. Nothing is written to storage.
 *
 * Nothing here logs a frame. The relay's whole point is that it cannot read
 * one, and a console.log of a payload would be the one way to break that.
 */
import { DurableObject } from "cloudflare:workers";
import {
  BOX_AUTH_PREFIX,
  LINK_PREFIX_BYTES,
  RELAY_CLOSE,
  RELAY_LIMITS,
  type BoxToRelay,
  type RelayToBox,
} from "@shahi/shared/relay";
import { hstsHeaders } from "./hsts.ts";
import { EVICTION_GRACE_MS, MAX_PENDING_BOXES, PHONE_FRAME_MIN_BYTES } from "./limits.ts";
import { ROUTE } from "./route.ts";
import { record, type TelemetryEnv, type Event } from "./telemetry.ts";

/**
 * How long a box may go without being heard from before the relay decides it
 * is dead and closes it. The Workers runtime cannot originate WebSocket ping
 * frames, so liveness runs the other way: the box sends the text frame `ping`
 * every twenty seconds, the runtime answers `pong` without waking this
 * object, and an alarm checks the timestamp of the last such answer. Five
 * minutes is fifteen missed pings — generous, because the cost of a false
 * positive is every phone on the box being dropped with 4404.
 */
export const BOX_SILENCE_MS = 5 * 60_000;

/** The attachment on a box socket. `ready` flips exactly once, on a good `auth`. */
interface BoxState {
  role: "box";
  serverId: string;
  nonce: string;
  ready: boolean;
  /** Terminal, including while the runtime retains a closing socket. */
  closed?: boolean;
  /** When the socket was accepted (pending) or authenticated (ready): the floor for the liveness check. */
  since: number;
  /** Last real frame from the box. Pings are answered by the runtime and tracked separately. */
  heard: number;
  /** Never reused within one box connection, so a stale `close` from the box can only name a dead link. */
  nextLink: number;
  /**
   * The box promised at `auth` to send `proven` for each link that proves
   * itself, so a link it has not vouched for may be closed for a newcomer. A
   * box older than that promise leaves this false, and only silent phones are.
   */
  proofs?: boolean;
  synthetic: boolean;
}

/** The attachment on a phone socket. */
interface PhoneState {
  role: "phone";
  link: number;
  /** The box this link belongs to, so a close event names it (telemetry). */
  serverId: string;
  /** False once the relay has closed the link itself, so the box is told exactly once. */
  open: boolean;
  /** When the socket was accepted: the clock for the first-frame deadline. */
  since: number;
  /** True once the phone has sent a frame — its hello. A socket that never does is squatting. */
  spoke: boolean;
  /** True once the box said the link holds the secret its hello named. Only the box can tell. */
  proven?: boolean;
  /** Last frame in either direction: a phone that only listens is not idle. */
  seen: number;
  /** Token bucket: bytes banked, and when they were last topped up. */
  tokens: number;
  refilled: number;
  upBytes: number;
  downBytes: number;
  upFrames: number;
  downFrames: number;
  measuredAt: number;
}

type Attachment = BoxState | PhoneState;

/** `CloseEvent` codes the relay uses beside the protocol's own. */
const CLOSE_NORMAL = 1000;

const encoder = new TextEncoder();

export class RelayBox extends DurableObject<unknown> {
  #env: TelemetryEnv;
  #synthetic = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#env = env as TelemetryEnv;
    this.#synthetic = ctx.getWebSockets("box").some((ws) => (ws.deserializeAttachment() as BoxState)?.synthetic === true);
    // `ping` → `pong` is answered inside the runtime, without waking this
    // object, and the answer's timestamp is what the liveness sweep reads.
    // Setting it on every construction is idempotent and keeps it from
    // depending on the order of events at first deploy.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /* ------------------------------------------------------------- connect */

  async fetch(request: Request): Promise<Response> {
    if (this.#env.STATS_TOKEN && request.headers.get("x-shahi-probe") === this.#env.STATS_TOKEN) this.#synthetic = true;
    const match = ROUTE.exec(new URL(request.url).pathname)!;
    const role = match[1]!;
    const serverId = match[2]!;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (role === "box") await this.acceptBox(server, serverId);
    else await this.acceptPhone(server, serverId);
    // Set here rather than by the Worker, which passes the upgrade through
    // untouched so its WebSocket is never re-wrapped (see hsts.ts).
    return new Response(null, { status: 101, webSocket: client, headers: hstsHeaders(request) });
  }

  private async acceptBox(ws: WebSocket, serverId: string): Promise<void> {
    const pending = this.ctx.getWebSockets("box").filter(other => {
      const state = other.deserializeAttachment() as BoxState;
      return other.readyState === WebSocket.OPEN && !state.closed && !state.ready;
    });
    if (pending.length >= MAX_PENDING_BOXES) {
      // The newcomer may be the real box reconnecting, and before `auth` the
      // relay cannot tell it from a squatter. So the longest-waiting pending
      // socket makes room, and the real box has its grace to prove itself
      // (see EVICTION_GRACE_MS). A socket that has already proven itself is
      // never pending, so the live box is not touched.
      const stale = longestWaiting(pending);
      if (!stale) return this.refuse(ws, RELAY_CLOSE.quota, "too many pending boxes", serverId);
      this.record({ kind: "refused", serverId, detail: "too many pending boxes", value: RELAY_CLOSE.quota });
      this.closeBox(stale, stale.deserializeAttachment() as BoxState, RELAY_CLOSE.quota, "too many pending boxes");
    }
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    // The socket is accepted before the old box is touched: a connection that
    // cannot prove the key must not be able to knock the real box offline,
    // so replacement happens on `auth`, not on connect.
    this.ctx.acceptWebSocket(ws, ["box"]);
    const now = Date.now();
    const state: BoxState = { role: "box", serverId, nonce, ready: false, since: now, heard: now, nextLink: 1, synthetic: this.#synthetic };
    ws.serializeAttachment(state);
    this.tell(ws, { t: "challenge", nonce });
    await this.schedule();
  }

  private async acceptPhone(ws: WebSocket, serverId: string): Promise<void> {
    const box = this.readyBox();
    if (!box) return this.refuse(ws, RELAY_CLOSE.boxOffline, "box offline", serverId);
    const phones = this.phones();
    const boxState = box.deserializeAttachment() as BoxState;
    if (phones.length >= RELAY_LIMITS.maxPhonesPerBox) {
      // The newcomer may be the owner's phone, so a link that has not shown it
      // belongs here makes room, provided it has had its grace. First one still
      // silent: a phone sends its hello the moment it opens. Then, on a box that
      // reports proofs, one that has spoken but never proven itself. A hello is
      // only a claim, and one naming a real device id without its secret used
      // to hold its slot until the box's fifteen-second proof deadline — any
      // revoked phone that had once read the device list could keep the owner
      // out that way (review 2026-09-22, F33). A proven link is never closed.
      // A box that reports nothing gets the old rule: a phone that has spoken
      // keeps its slot.
      const unproven = phones.filter((phone) => !(phone.deserializeAttachment() as PhoneState).proven);
      const silent = unproven.filter((phone) => !(phone.deserializeAttachment() as PhoneState).spoke);
      const squatter = longestWaiting(silent) ?? (boxState.proofs ? longestWaiting(unproven) : null);
      if (!squatter) return this.refuse(ws, RELAY_CLOSE.quota, "too many phones", serverId);
      this.closePhone(squatter, squatter.deserializeAttachment() as PhoneState, RELAY_CLOSE.quota, "too many phones");
    }
    const link = boxState.nextLink;
    box.serializeAttachment({ ...boxState, nextLink: link + 1 });
    this.ctx.acceptWebSocket(ws, ["phone", linkTag(link)]);
    const now = Date.now();
    const state: PhoneState = {
      role: "phone",
      link,
      serverId,
      open: true,
      since: now,
      spoke: false,
      seen: now,
      tokens: RELAY_LIMITS.phoneBurstBytes,
      refilled: now,
      upBytes: 0, downBytes: 0, upFrames: 0, downFrames: 0, measuredAt: now,
    };
    ws.serializeAttachment(state);
    this.tell(box, { t: "open", link });
    this.record({ kind: "phone_open", serverId, value: this.phones().length });
    await this.schedule();
  }

  /**
   * Accepts and immediately closes: a WebSocket client cannot read an HTTP
   * status, so "box offline" has to travel as a close code on a socket that
   * did open. Accepted through the hibernation API like every other socket —
   * a plain `accept()` here made workerd report "Network connection lost" as
   * an uncaught error on every refusal, because the close ran before the
   * response's pump was attached.
   */
  private refuse(ws: WebSocket, code: number, reason: string, serverId: string): void {
    this.ctx.acceptWebSocket(ws, ["refused"]);
    this.record({ kind: "refused", serverId, detail: reason, value: code });
    ws.close(code, reason);
  }

  /* -------------------------------------------------------------- frames */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as Attachment | null;
    if (!state) { ws.close(1002, "unexpected frame"); return; }
    if (ws.readyState !== WebSocket.OPEN || (state.role === "box" ? state.closed : !state.open)) return;
    // The limit is in bytes. `length` counts UTF-16 code units, so on its own
    // it let up to ~12 KB of three-byte characters through (pre-release bug
    // hunt, B105). A string's UTF-8 is never shorter than its length, so
    // `length` still refuses the largest frames without encoding them.
    if (typeof message === "string" && (message.length > RELAY_LIMITS.maxControlBytes || encoder.encode(message).byteLength > RELAY_LIMITS.maxControlBytes)) {
      if (state.role === "phone") this.closePhone(ws, state, RELAY_CLOSE.quota, "control too large");
      else this.closeBox(ws, state, RELAY_CLOSE.quota, "control too large");
      return;
    }
    try {
      if (state.role === "phone") this.fromPhone(ws, state, message);
      else if (state.ready) this.fromReadyBox(ws, state, message);
      else await this.authenticate(ws, state, message);
    } catch {
      this.record({ kind: "internal_error", serverId: state.serverId, detail: "socket handler" });
      if (state.role === "phone") this.closePhone(ws, state, 1011, "send failed");
      else this.closeBox(ws, state, 1011, "send failed");
    }
  }

  private fromPhone(ws: WebSocket, state: PhoneState, message: string | ArrayBuffer): void {
    if (!state.open) return;
    const text = typeof message === "string";
    const size = text ? encoder.encode(message).byteLength : message.byteLength;
    if (size > RELAY_LIMITS.maxFrameBytes) return this.closePhone(ws, state, RELAY_CLOSE.quota, "frame too large");
    const now = Date.now();
    const banked = Math.min(
      RELAY_LIMITS.phoneBurstBytes,
      state.tokens + ((now - state.refilled) * RELAY_LIMITS.phoneBytesPerSecond) / 1000,
    );
    // Every frame wakes this object, so every frame pays, and never less than
    // the floor: the rate limit is on frames as well as bytes (see limits.ts).
    const cost = Math.max(size, PHONE_FRAME_MIN_BYTES);
    if (cost > banked) return this.closePhone(ws, state, RELAY_CLOSE.quota, "rate");
    if (text) {
      // Text is relay control, and a phone has nothing to control: dropped,
      // not forwarded, so a phone can never speak to the box in the clear. It
      // is not a hello and not activity either. It used to return before the
      // bucket was read, which made text free (review 2026-09-22, F79).
      ws.serializeAttachment({ ...state, tokens: banked - cost, refilled: now });
      return;
    }
    const box = this.readyBox();
    // No history and no store-and-forward: a frame with nobody to give it to
    // is dropped and the phone told why, so it reconnects and asks again.
    if (!box) return this.closePhone(ws, state, RELAY_CLOSE.boxOffline, "box offline");
    // First frame: the phone has spoken, so it holds its slot for the full
    // idle window rather than the short hello deadline.
    ws.serializeAttachment({ ...state, spoke: true, seen: now, tokens: banked - cost, refilled: now, upBytes: state.upBytes + size, upFrames: state.upFrames + 1 });
    const framed = new Uint8Array(LINK_PREFIX_BYTES + size);
    new DataView(framed.buffer).setUint32(0, state.link);
    framed.set(new Uint8Array(message), LINK_PREFIX_BYTES);
    box.send(framed);
  }

  private fromReadyBox(ws: WebSocket, state: BoxState, message: string | ArrayBuffer): void {
    ws.serializeAttachment({ ...state, heard: Date.now() });
    if (typeof message === "string") {
      const control = parse<BoxToRelay>(message);
      if ((control?.t !== "close" && control?.t !== "proven") || typeof control.link !== "number") return;
      const phone = this.phone(control.link);
      if (!phone) return;
      const phoneState = phone.deserializeAttachment() as PhoneState;
      if (control.t === "proven") {
        phone.serializeAttachment({ ...phoneState, proven: true });
        return;
      }
      // The box asked, so it is not told again.
      this.traffic(phoneState);
      this.record({ kind: "phone_close", serverId: state.serverId, detail: "closed by box", value: CLOSE_NORMAL, durationMs: Date.now() - phoneState.since });
      phone.serializeAttachment({ ...phoneState, open: false });
      phone.close(CLOSE_NORMAL, "closed by box");
      return;
    }
    if (message.byteLength < LINK_PREFIX_BYTES) return;
    const size = message.byteLength - LINK_PREFIX_BYTES;
    const link = new DataView(message).getUint32(0);
    const phone = this.phone(link);
    if (!phone) return;
    const phoneState = phone.deserializeAttachment() as PhoneState;
    if (!phoneState.open) return;
    if (size > RELAY_LIMITS.maxFrameBytes) return this.closePhone(phone, phoneState, RELAY_CLOSE.quota, "frame too large");
    phone.serializeAttachment({ ...phoneState, seen: Date.now(), downBytes: phoneState.downBytes + size, downFrames: phoneState.downFrames + 1 });
    try { phone.send(message.slice(LINK_PREFIX_BYTES)); }
    catch { this.closePhone(phone, phone.deserializeAttachment() as PhoneState, 1011, "send failed"); }
  }

  /* ---------------------------------------------------------------- auth */

  private async authenticate(ws: WebSocket, state: BoxState, message: string | ArrayBuffer): Promise<void> {
    if (Date.now() >= state.since + RELAY_LIMITS.boxAuthTimeoutMs) {
      this.closeBox(ws, state, RELAY_CLOSE.unauthorized, "auth timeout");
      return;
    }
    const auth = typeof message === "string" ? parse<BoxToRelay>(message) : null;
    if (auth?.t !== "auth" || !(await proves(auth, state))) {
      this.record({ kind: "auth_failed", serverId: state.serverId, detail: "unauthorized" });
      this.closeBox(ws, state, RELAY_CLOSE.unauthorized, "unauthorized");
      return;
    }
    // Verification yields. A timeout, replacement or another authentication
    // may have completed while WebCrypto was running.
    const current = ws.deserializeAttachment() as BoxState;
    if (current.closed || current.ready || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() >= current.since + RELAY_LIMITS.boxAuthTimeoutMs) {
      this.closeBox(ws, current, RELAY_CLOSE.unauthorized, "auth timeout");
      return;
    }
    // The newcomer has the key, so whatever was here before is a zombie or a
    // predecessor: it goes, and so do its phones — their end-to-end sessions
    // were with a process that no longer answers, and the new box has never
    // heard of their links.
    for (const other of this.ctx.getWebSockets("box")) {
      if (other === ws) continue;
      this.closeBox(other, other.deserializeAttachment() as BoxState, RELAY_CLOSE.replaced, "replaced");
    }
    const now = Date.now();
    ws.serializeAttachment({ ...state, ready: true, since: now, heard: now, proofs: auth.proofs === true });
    this.tell(ws, { t: "ready" });
    this.record({ kind: "box_auth", serverId: state.serverId, durationMs: now - state.since });
    await this.schedule();
  }

  /* ------------------------------------------------------------- closing */

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  /** A socket the peer closed, or that errored: tidy what it was holding. */
  private async gone(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as Attachment | null;
    // A refused socket held nothing and changed no deadline; re-arming the
    // alarm for it is a storage write per refusal, and a phone whose box is
    // offline reconnects all day (measured: ~100k refusals per phone-day
    // before the app backed off properly). Nothing to schedule.
    if (!state) return;
    if (state.role === "phone") this.closePhone(ws, state, CLOSE_NORMAL, "gone");
    else if (state.role === "box") this.closeBox(ws, state, CLOSE_NORMAL, "gone");
    await this.schedule();
  }

  /** Ends a link: the box is told once, then the phone is closed with the reason. */
  private closePhone(ws: WebSocket, state: PhoneState, code: number, reason: string): void {
    if (state.open) {
      ws.serializeAttachment({ ...state, open: false });
      const box = this.readyBox();
      if (box) this.tell(box, { t: "close", link: state.link });
      this.traffic(state);
      this.record({ kind: "phone_close", serverId: state.serverId, detail: reason, value: code, durationMs: Date.now() - state.since });
    }
    ws.close(code, reason);
  }

  /** Ends a box connection; if it was the ready one, every phone learns the box is offline. */
  private closeBox(ws: WebSocket, state: BoxState, code: number, reason: string): void {
    state = ws.deserializeAttachment() as BoxState;
    if (state.closed) return;
    ws.serializeAttachment({ ...state, ready: false, closed: true });
    if (state.ready) {
      this.record({ kind: "box_gone", serverId: state.serverId, detail: reason, value: code, durationMs: Date.now() - state.since });
      for (const phone of this.phones()) {
        // `open: false` first: the box being told about these links is the one
        // that is leaving, and a `close` on the ready socket would otherwise
        // reach whichever box replaced it.
        const phoneState = phone.deserializeAttachment() as PhoneState;
        this.traffic(phoneState);
        this.record({ kind: "phone_close", serverId: state.serverId, detail: "box offline", value: RELAY_CLOSE.boxOffline, durationMs: Date.now() - phoneState.since });
        phone.serializeAttachment({ ...phoneState, open: false });
        phone.close(RELAY_CLOSE.boxOffline, "box offline");
      }
    }
    ws.close(code, reason);
  }

  /* -------------------------------------------------------------- alarms */

  /**
   * Deadlines that must fire while nothing else happens: a box that never
   * answers the challenge, a box that stopped pinging, a phone with no
   * traffic. One alarm, set to the earliest of them, re-armed on connect,
   * close and after each firing — never per frame, which would be a storage
   * write per frame. Deadlines only ever move later, so an alarm that fires
   * and finds its socket fresh simply re-arms at the new time: a box that
   * pings wakes this object once per BOX_SILENCE_MS, and nothing else does.
   */
  private async schedule(): Promise<void> {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.deadline(ws);
      if (deadline !== null && deadline < next) next = deadline;
    }
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const box = this.readyBox();
    if (box) this.record({ kind: "box_presence", serverId: (box.deserializeAttachment() as BoxState).serverId, value: this.phones().length });
    for (const phone of this.phones()) {
      const state = phone.deserializeAttachment() as PhoneState;
      this.traffic(state);
      phone.serializeAttachment({ ...state, upBytes: 0, downBytes: 0, upFrames: 0, downFrames: 0, measuredAt: now });
    }
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.deadline(ws);
      if (deadline === null || deadline > now) continue;
      const state = ws.deserializeAttachment() as Attachment;
      if (state.role === "phone") this.closePhone(ws, state, CLOSE_NORMAL, state.spoke ? "idle" : "no hello");
      else if (state.ready) this.closeBox(ws, state, CLOSE_NORMAL, "silent");
      else this.closeBox(ws, state, RELAY_CLOSE.unauthorized, "auth timeout");
    }
    await this.schedule();
  }

  /** When this socket is due to be closed if nothing happens, or null if it is already closing. */
  private deadline(ws: WebSocket): number | null {
    const state = ws.deserializeAttachment() as Attachment | null;
    if (!state || ws.readyState !== WebSocket.OPEN) return null;
    if (state.role === "phone") {
      if (!state.open) return null;
      // A phone that has not spoken yet is on a short leash; once it has, the
      // idle window (measured from its last frame) takes over.
      return state.spoke ? state.seen + RELAY_LIMITS.phoneIdleMs : state.since + RELAY_LIMITS.phoneHelloMs;
    }
    if (state.closed) return null;
    if (!state.ready) return state.since + RELAY_LIMITS.boxAuthTimeoutMs;
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(state.since, state.heard, pong) + BOX_SILENCE_MS;
  }

  private record(event: Event): void { record(this.#env, { ...event, synthetic: this.#synthetic }); }

  private traffic(state: PhoneState): void {
    if (!state.upFrames && !state.downFrames) return;
    this.record({ kind: "traffic", serverId: state.serverId, upBytes: state.upBytes, downBytes: state.downBytes,
      upFrames: state.upFrames, downFrames: state.downFrames, durationMs: Date.now() - state.measuredAt });
  }

  /* ------------------------------------------------------------- lookups */

  private readyBox(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets("box")) {
      const state = ws.deserializeAttachment() as BoxState;
      if (ws.readyState === WebSocket.OPEN && state.ready && !state.closed) return ws;
    }
    return null;
  }

  private phones(): WebSocket[] {
    return this.ctx
      .getWebSockets("phone")
      .filter((ws) => (ws.deserializeAttachment() as PhoneState).open);
  }

  private phone(link: number): WebSocket | null {
    return this.ctx.getWebSockets(linkTag(link)).find(ws => ws.readyState === WebSocket.OPEN && (ws.deserializeAttachment() as PhoneState).open) ?? null;
  }

  private tell(ws: WebSocket, message: RelayToBox): void {
    try { ws.send(JSON.stringify(message)); } catch { this.record({ kind: "internal_error", serverId: "", detail: "control send" }); }
  }
}

/* ---------------------------------------------------------------- helpers */

function linkTag(link: number): string {
  return `link:${link}`;
}

/** The socket that has waited longest, if it has had its grace: the one a newcomer may displace. */
function longestWaiting(sockets: WebSocket[]): WebSocket | null {
  const cutoff = Date.now() - EVICTION_GRACE_MS;
  let oldest: WebSocket | null = null;
  let oldestSince = cutoff;
  for (const ws of sockets) {
    const { since } = ws.deserializeAttachment() as Attachment;
    if (since <= oldestSince) {
      oldest = ws;
      oldestSince = since;
    }
  }
  return oldest;
}

function parse<T>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `auth` proves ownership of the box's serverId: the public key must
 * hash to the id, and the signature must be that key's over the prefix, the
 * id and the nonce this socket was challenged with.
 *
 * WebCrypto rather than @noble: the runtime implements Ed25519 and SHA-256
 * natively, so the Worker bundles no cryptography and has no dependency to
 * keep current. The relay never needs the parts WebCrypto lacks (X25519 for
 * the app's e2e session is the box's and the phone's business).
 */
async function proves(auth: { pub: string; sig: string }, state: BoxState): Promise<boolean> {
  const pub = fromBase64url(auth.pub);
  const sig = fromBase64url(auth.sig);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pub));
  if (base64url(digest) !== state.serverId) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(BOX_AUTH_PREFIX + state.serverId + state.nonce);
    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {
    return false;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
