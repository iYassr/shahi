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
 * itself, and the next link number; a phone's carries its link, its token
 * bucket and when it was last heard from. Nothing is written to storage.
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
import { ROUTE } from "./route.ts";
import { record, type TelemetryEnv } from "./telemetry.ts";

/**
 * How long a box may go without being heard from before the relay decides it
 * is dead and closes it. The Workers runtime cannot originate WebSocket ping
 * frames, so liveness runs the other way: the box sends the text frame `ping`
 * once a minute, the runtime answers `pong` without waking this object, and
 * an alarm checks the timestamp of the last such answer. Five minutes is
 * five missed pings — generous, because the cost of a false positive is every
 * phone on the box being dropped with 4404.
 */
export const BOX_SILENCE_MS = 5 * 60_000;

/** The attachment on a box socket. `ready` flips exactly once, on a good `auth`. */
interface BoxState {
  role: "box";
  serverId: string;
  nonce: string;
  ready: boolean;
  /** When the socket was accepted (pending) or authenticated (ready): the floor for the liveness check. */
  since: number;
  /** Last real frame from the box. Pings are answered by the runtime and tracked separately. */
  heard: number;
  /** Never reused within one box connection, so a stale `close` from the box can only name a dead link. */
  nextLink: number;
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
  /** Last frame in either direction: a phone that only listens is not idle. */
  seen: number;
  /** Token bucket: bytes banked, and when they were last topped up. */
  tokens: number;
  refilled: number;
}

type Attachment = BoxState | PhoneState;

/** `CloseEvent` codes the relay uses beside the protocol's own. */
const CLOSE_NORMAL = 1000;

export class RelayBox extends DurableObject<unknown> {
  #env: TelemetryEnv;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#env = env as TelemetryEnv;
    // `ping` → `pong` is answered inside the runtime, without waking this
    // object, and the answer's timestamp is what the liveness sweep reads.
    // Setting it on every construction is idempotent and keeps it from
    // depending on the order of events at first deploy.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /* ------------------------------------------------------------- connect */

  async fetch(request: Request): Promise<Response> {
    const match = ROUTE.exec(new URL(request.url).pathname)!;
    const role = match[1]!;
    const serverId = match[2]!;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (role === "box") await this.acceptBox(server, serverId);
    else await this.acceptPhone(server, serverId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptBox(ws: WebSocket, serverId: string): Promise<void> {
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    // The socket is accepted before the old box is touched: a connection that
    // cannot prove the key must not be able to knock the real box offline,
    // so replacement happens on `auth`, not on connect.
    this.ctx.acceptWebSocket(ws, ["box"]);
    const now = Date.now();
    const state: BoxState = { role: "box", serverId, nonce, ready: false, since: now, heard: now, nextLink: 1 };
    ws.serializeAttachment(state);
    this.tell(ws, { t: "challenge", nonce });
    await this.schedule();
  }

  private async acceptPhone(ws: WebSocket, serverId: string): Promise<void> {
    const box = this.readyBox();
    if (!box) return this.refuse(ws, RELAY_CLOSE.boxOffline, "box offline", serverId);
    if (this.phones().length >= RELAY_LIMITS.maxPhonesPerBox) {
      return this.refuse(ws, RELAY_CLOSE.quota, "too many phones", serverId);
    }
    const boxState = box.deserializeAttachment() as BoxState;
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
    };
    ws.serializeAttachment(state);
    this.tell(box, { t: "open", link });
    record(this.#env, { kind: "phone_open", serverId, value: this.phones().length });
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
    record(this.#env, { kind: "refused", serverId, detail: reason, value: code });
    ws.close(code, reason);
  }

  /* -------------------------------------------------------------- frames */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as Attachment;
    if (state.role === "phone") this.fromPhone(ws, state, message);
    else if (state.ready) this.fromReadyBox(ws, state, message);
    else await this.authenticate(ws, state, message);
  }

  private fromPhone(ws: WebSocket, state: PhoneState, message: string | ArrayBuffer): void {
    // Text is relay control, and a phone has nothing to control: dropped, not
    // forwarded, so a phone can never speak to the box in the clear.
    if (typeof message === "string" || !state.open) return;
    const size = message.byteLength;
    if (size > RELAY_LIMITS.maxFrameBytes) return this.closePhone(ws, state, RELAY_CLOSE.quota, "frame too large");
    const now = Date.now();
    const banked = Math.min(
      RELAY_LIMITS.phoneBurstBytes,
      state.tokens + ((now - state.refilled) * RELAY_LIMITS.phoneBytesPerSecond) / 1000,
    );
    if (size > banked) return this.closePhone(ws, state, RELAY_CLOSE.quota, "rate");
    const box = this.readyBox();
    // No history and no store-and-forward: a frame with nobody to give it to
    // is dropped and the phone told why, so it reconnects and asks again.
    if (!box) return this.closePhone(ws, state, RELAY_CLOSE.boxOffline, "box offline");
    // First frame: the phone has spoken, so it holds its slot for the full
    // idle window rather than the short hello deadline.
    ws.serializeAttachment({ ...state, spoke: true, seen: now, tokens: banked - size, refilled: now });
    const framed = new Uint8Array(LINK_PREFIX_BYTES + size);
    new DataView(framed.buffer).setUint32(0, state.link);
    framed.set(new Uint8Array(message), LINK_PREFIX_BYTES);
    box.send(framed);
  }

  private fromReadyBox(ws: WebSocket, state: BoxState, message: string | ArrayBuffer): void {
    ws.serializeAttachment({ ...state, heard: Date.now() });
    if (typeof message === "string") {
      const control = parse<BoxToRelay>(message);
      if (control?.t !== "close" || typeof control.link !== "number") return;
      const phone = this.phone(control.link);
      if (!phone) return;
      // The box asked, so it is not told again.
      const phoneState = phone.deserializeAttachment() as PhoneState;
      phone.serializeAttachment({ ...phoneState, open: false });
      phone.close(CLOSE_NORMAL, "closed by box");
      return;
    }
    if (message.byteLength < LINK_PREFIX_BYTES) return;
    const size = message.byteLength - LINK_PREFIX_BYTES;
    // The box has proven its key, so an oversized frame is a bug on its side
    // rather than an attack; closing the box makes it loud rather than
    // silently starving one phone.
    if (size > RELAY_LIMITS.maxFrameBytes) return this.closeBox(ws, state, RELAY_CLOSE.quota, "frame too large");
    const link = new DataView(message).getUint32(0);
    const phone = this.phone(link);
    if (!phone) return;
    const phoneState = phone.deserializeAttachment() as PhoneState;
    if (!phoneState.open) return;
    phone.serializeAttachment({ ...phoneState, seen: Date.now() });
    phone.send(message.slice(LINK_PREFIX_BYTES));
  }

  /* ---------------------------------------------------------------- auth */

  private async authenticate(ws: WebSocket, state: BoxState, message: string | ArrayBuffer): Promise<void> {
    const auth = typeof message === "string" ? parse<BoxToRelay>(message) : null;
    if (auth?.t !== "auth" || !(await proves(auth, state))) {
      ws.close(RELAY_CLOSE.unauthorized, "unauthorized");
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
    ws.serializeAttachment({ ...state, ready: true, since: now, heard: now });
    this.tell(ws, { t: "ready" });
    record(this.#env, { kind: "box_auth", serverId: state.serverId });
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
      record(this.#env, { kind: "phone_close", serverId: state.serverId, detail: reason, value: code });
    }
    ws.close(code, reason);
  }

  /** Ends a box connection; if it was the ready one, every phone learns the box is offline. */
  private closeBox(ws: WebSocket, state: BoxState, code: number, reason: string): void {
    if (state.ready) {
      ws.serializeAttachment({ ...state, ready: false });
      record(this.#env, { kind: "box_gone", serverId: state.serverId, detail: reason, value: code });
      for (const phone of this.phones()) {
        // `open: false` first: the box being told about these links is the one
        // that is leaving, and a `close` on the ready socket would otherwise
        // reach whichever box replaced it.
        phone.serializeAttachment({ ...(phone.deserializeAttachment() as PhoneState), open: false });
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
    if (!state) return null;
    if (state.role === "phone") {
      if (!state.open) return null;
      // A phone that has not spoken yet is on a short leash; once it has, the
      // idle window (measured from its last frame) takes over.
      return state.spoke ? state.seen + RELAY_LIMITS.phoneIdleMs : state.since + RELAY_LIMITS.phoneHelloMs;
    }
    if (!state.ready) return state.since + RELAY_LIMITS.boxAuthTimeoutMs;
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(state.since, state.heard, pong) + BOX_SILENCE_MS;
  }

  /* ------------------------------------------------------------- lookups */

  private readyBox(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets("box")) {
      if ((ws.deserializeAttachment() as BoxState).ready) return ws;
    }
    return null;
  }

  private phones(): WebSocket[] {
    return this.ctx
      .getWebSockets("phone")
      .filter((ws) => (ws.deserializeAttachment() as PhoneState).open);
  }

  private phone(link: number): WebSocket | null {
    return this.ctx.getWebSockets(linkTag(link))[0] ?? null;
  }

  private tell(ws: WebSocket, message: RelayToBox): void {
    ws.send(JSON.stringify(message));
  }
}

/* ---------------------------------------------------------------- helpers */

function linkTag(link: number): string {
  return `link:${link}`;
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
