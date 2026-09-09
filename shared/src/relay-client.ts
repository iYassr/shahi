/**
 * The phone's half of the blind relay — `docs/relay.md` is the protocol.
 *
 * One WebSocket to `<relay>/v1/phone/<serverId>` carries everything the app
 * says to a box it cannot reach directly: a hello in the clear, then sealed
 * frames from `shared/src/e2e.ts` holding requests, their responses, and the
 * same dashboard stream `/ws` pushes. The relay forwards bytes it cannot read.
 *
 * Nothing above `api.ts` knows this exists. `request()` builds the same
 * method, path, headers and body it always did and hands them here when the
 * connection is a relay one; `SessionSocket` subscribes to this link instead
 * of opening its own. That is the whole point of the seam: a relay is a
 * transport, and the screens should never learn transport.
 *
 * What the relay does not get to see or do is what shapes this file. The
 * secret the frames are keyed from never travels — the hello names it by
 * device id or by the hash of a pairing code — so a relay, or anyone who
 * knows a `serverId`, derives different keys and the box refuses its first
 * frame. Randomness for the ephemeral key comes from the platform CSPRNG, never
 * `Math.random`: the private half is what makes the exchange forward-secret.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  RELAY_CLOSE,
  RELAY_LIMITS,
  RELAY_PROTOCOL,
  type BoxHello,
  type BoxToPhone,
  type PhoneHello,
  type PhoneToBox,
  type RelayResponse,
  type SocketMessage,
} from "./index";
import { clientSession, ephemeral, open, seal, type Ephemeral, type Session } from "./e2e";
import { UnauthorizedError, UnreachableError, hostOf } from "./errors";
import { retryDelay } from "./retry";

/** What the keychain keeps for a box reached through a relay. */
export interface RelayIdentity {
  /** The relay's base URL, from the pairing code. */
  relay: string;
  serverId: string;
  deviceId: string;
  /** base64url, 32 bytes: this phone's share of the E2E key for that box. */
  deviceSecret: string;
}

/** Everything a link needs to open: where, as whom, and the secret to key from. */
export interface RelayTarget {
  relay: string;
  serverId: string;
  auth: PhoneHello["auth"];
  /** 32 bytes: the device secret, or the pairing secret before there is a device. */
  secret: Uint8Array;
}

/** A paired phone's link. */
export function deviceTarget(identity: RelayIdentity): RelayTarget {
  return {
    relay: identity.relay,
    serverId: identity.serverId,
    auth: { kind: "device", deviceId: identity.deviceId },
    secret: fromBase64Url(identity.deviceSecret),
  };
}

/**
 * A link for a phone that has only scanned a code. The box knows the code by
 * the hash of its bytes; the secret itself stays here, mixed into the keys.
 */
export function pairingTarget(relay: string, serverId: string, secret: string): RelayTarget {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(secret);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes.length !== 32) throw new Error("This code's secret is not one a Shahi server prints. Print a new code.");
  return { relay, serverId, auth: { kind: "pairing", id: toBase64Url(sha256(bytes)) }, secret: bytes };
}

/** A request as `api.ts` builds it, before the transport decides how it travels. */
export interface OutgoingRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/**
 * What a request answers with, over either transport. The subset of `Response`
 * that `api.ts` reads — the HTTP path hands a real one through, and the relay
 * builds this from a `RelayResponse`.
 */
export interface Reply {
  ok: boolean;
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export type LinkState = "connecting" | "live" | "lost";

/** What the app's socket wants to hear: the same three callbacks it has today. */
export interface LinkSubscriber {
  onMessage(msg: SocketMessage): void;
  onLink(state: LinkState): void;
  /** The box or the relay refused this phone: it is no longer paired. */
  onExpired?(): void;
}

const utf8 = { encode: (s: string) => new TextEncoder().encode(s), decode: (b: Uint8Array) => new TextDecoder().decode(b) };

/** How long the box may be silent before the link counts as dead — same as `/ws`. */
const SILENCE_LIMIT_MS = 70_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

interface Pending {
  id: number;
  request: OutgoingRequest;
  sent: boolean;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One link to one box, reconnecting on its own.
 *
 * Requests are matched to responses by an incrementing id and rejected after
 * the caller's timeout. A request is never resent: if the link closes while
 * one is in flight it is rejected with why, and the caller — the reader's
 * poll, a tap — retries as it would after a dropped HTTP request. Anything
 * else would risk delivering a prompt twice.
 */
export class RelayLink {
  #ws: WebSocket | undefined;
  #self: Ephemeral | null = null;
  #session: Session | null = null;
  #confirmed = false;
  #state: LinkState = "lost";
  #pending = new Map<number, Pending>();
  #receivedBytes = 0;
  #liveSince = 0;
  #nextId = 1;
  #backoffMs = 500;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #attemptAt = 0;
  #lastMessageAt = 0;
  #closed = false;
  #watching: string | null = null;
  #subscribers = new Set<LinkSubscriber>();
  readonly host: string;

  constructor(readonly target: RelayTarget, private readonly options: { randomBytes?: (length: number) => Uint8Array; retryRandom?: () => number } = {}) {
    this.host = hostOf(target.relay);
  }

  get state(): LinkState {
    return this.#state;
  }

  /** Hears the stream and the link state; told the current state at once. */
  subscribe(sub: LinkSubscriber): void {
    this.#subscribers.add(sub);
    sub.onLink(this.#state);
  }

  unsubscribe(sub: LinkSubscriber): void {
    this.#subscribers.delete(sub);
  }

  /** Opens the link now if it is not up — for a request, or for coming back to the app. */
  ensureConnected(): void {
    this.#closed = false;
    this.#watchdog ??= setInterval(() => this.#checkAlive(), WATCHDOG_INTERVAL_MS);
    if (this.#ws && this.#ws.readyState <= 1) {
      if (this.#ws.readyState === 1) this.#checkAlive();
      return;
    }
    if (this.#ws) {
      this.#drop(this.#ws, this.#lost());
      return;
    }
    // Polling must respect an already scheduled retry, including while offline.
    if (this.#timer) return;
    this.#open();
  }

  /** A real network/foreground transition may bypass the ordinary retry delay. */
  reconnect(): void {
    if (this.#closed) return;
    this.#watchdog ??= setInterval(() => this.#checkAlive(), WATCHDOG_INTERVAL_MS);
    // Native reachability and foreground events often arrive together. Keep
    // the fresh attempt instead of cancelling it with the second event.
    if (this.#ws && Date.now() - this.#attemptAt < 1000) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#backoffMs = 500;
    if (this.#ws) this.#drop(this.#ws, this.#lost(), true);
    else { this.#retry(true); this.#setState("lost"); }
  }

  /** Ends the link for good: a sign-out, or a target that changed under it. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#timer = undefined;
    this.#watchdog = undefined;
    const socket = this.#ws;
    if (socket) this.#discard(socket);
    this.#rejectAll(new UnreachableError("lost", this.host, `The connection through ${this.host} was closed.`));
    this.#setState("lost");
  }

  /** Which pane the box should push frames for, sent now and after every reconnect. */
  watch(paneId: string | null): void {
    this.#watching = paneId;
    if (!this.#session) return;
    this.#sendSealed({ t: "ws", data: paneId ? { type: "watch", paneId } : { type: "unwatch" } });
  }

  /**
   * Sends a request and resolves with its answer. Opens the link if it is not
   * up; the timeout runs from now, so waiting for the box counts against it
   * exactly as connecting does on the HTTP path.
   */
  request(request: OutgoingRequest, timeoutMs: number): Promise<Reply> {
    if (request.body && request.body.byteLength > RELAY_LIMITS.maxBodyBytes) {
      return Promise.reject(new UnreachableError("relay", this.host, `That was too big to send through the relay: one message carries up to ${humanSize(RELAY_LIMITS.maxBodyBytes)}.`));
    }
    const heldBytes = [...this.#pending.values()].reduce((n, p) => n + (p.request.body?.byteLength ?? 0), 0);
    if (this.#pending.size >= RELAY_LIMITS.maxPendingRequests || heldBytes + (request.body?.byteLength ?? 0) > RELAY_LIMITS.maxPendingBodyBytes) {
      return Promise.reject(new UnreachableError("relay", this.host, "Too many requests are waiting for this box. Try again shortly."));
    }
    return new Promise<Reply>((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(
          new UnreachableError(
            "timeout",
            this.host,
            `Your box didn't answer within ${Math.round(timeoutMs / 1000)} seconds. It is connected to the relay, so it may be busy or asleep.`,
          ),
        );
      }, timeoutMs);
      const pending: Pending = { id, request, sent: false, resolve, reject, timer };
      this.#pending.set(id, pending);
      if (this.#session) this.#dispatch(pending);
      else this.ensureConnected();
    });
  }

  #open(): void {
    if (this.#closed) return;
    this.#setState("connecting");

    const url = `${this.target.relay.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/phone/${encodeURIComponent(this.target.serverId)}`;
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { this.#rejectAll(this.#lost()); this.#retry(); this.#setState("lost"); return; }
    // Sealed frames are bytes. Left on the default, React Native hands each
    // one over as a Blob that has to be read back asynchronously.
    socket.binaryType = "arraybuffer";
    this.#ws = socket;
    this.#attemptAt = Date.now();
    // Includes CONNECTING and the encrypted hello. Neither state is covered
    // by the established-session heartbeat, and native may never emit close.
    this.#handshakeTimer = setTimeout(() => {
      if (this.#ws === socket && !this.#confirmed) this.#drop(socket, this.#lost());
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.#ws !== socket || this.#closed) return;
      // The backoff is reset on the box's hello, not here: a refused link
      // (a ninth phone, a box that is offline) *opens* and then closes with
      // a code, and resetting on open made the phone knock every ~0.8s for
      // as long as the app was up — ~100k relay requests a day from one
      // phone, the free plan's whole quota (measured, 2026-09-02).
      this.#lastMessageAt = Date.now();
      // A fresh key per connection is what makes a leaked secret useless
      // against past sessions; the bytes come from the platform's CSPRNG.
      try {
        this.#self = ephemeral((this.options.randomBytes ?? secureRandomBytes)(32));
        const hello: PhoneHello = { t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(this.#self.pub), auth: this.target.auth };
        // Bytes, not text: the relay forwards data frames and drops text from
        // phones, which is relay control. The box answers the same way.
        socket.send(utf8.encode(JSON.stringify(hello)));
      } catch { this.#drop(socket, this.#lost()); }
    };
    socket.onmessage = (event: { data: unknown }) => {
      if (this.#ws !== socket || this.#closed) return;
      this.#lastMessageAt = Date.now();
      if (typeof event.data === "string") {
        // The relay sends phones no text; whatever this is, it is not ours.
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > RELAY_LIMITS.maxFrameBytes) {
        this.#drop(socket, new UnreachableError("relay", this.host, "The relay sent an invalid or oversized frame."));
        return;
      }
      if (!this.#session) {
        // The first data frame is the box's hello, in the clear.
        try {
          if (event.data.byteLength > 4096) throw new Error("oversized hello");
          this.#onHello(utf8.decode(new Uint8Array(event.data)));
        } catch {
          this.#drop(socket, new UnreachableError("relay", this.host, "The secure relay handshake was invalid."));
        }
        return;
      }
      let plain: Uint8Array;
      try {
        plain = open(this.#session, new Uint8Array(event.data as ArrayBuffer));
      } catch {
        // A box replacement can race a late frame from the old encrypted
        // session. That says this connection is stale, not that the durable
        // device credential was revoked. Only an authenticated sealed `bye`
        // below is authority to erase a saved pairing.
        this.#drop(socket, new UnreachableError("lost", this.host, `The secure connection through ${this.host} changed. Reconnecting…`));
        return;
      }
      this.#confirmed = true;
      clearTimeout(this.#handshakeTimer); this.#handshakeTimer = undefined;
      this.#receivedBytes += event.data.byteLength;
      this.#receive(plain);
      if (this.#receivedBytes >= RELAY_LIMITS.acknowledgeBytes && this.#session) {
        const bytes = this.#receivedBytes;
        this.#receivedBytes = 0;
        this.#sendSealed({ t: "ack", bytes });
      }
    };
    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (this.#ws !== socket) return;
      const code = event?.code ?? 0;
      const reason = event?.reason ?? "";
      if (
        (code === RELAY_CLOSE.unauthorized || code === RELAY_CLOSE.forbidden) &&
        this.target.auth.kind === "pairing"
      ) {
        // A one-time pairing link being refused is terminal: there is no
        // saved identity yet, and retrying a spent/bad code cannot succeed.
        this.#refuse("This phone is no longer paired with that box.");
        return;
      }
      if (code === RELAY_CLOSE.unauthorized || code === RELAY_CLOSE.forbidden) {
        // A transport close is not authenticated. During a sidecar restart a
        // stale/new link race can produce either code, so retain the saved
        // device and reconnect. Revocation travels as a sealed `bye` instead.
        this.#drop(socket,
          new UnreachableError("lost", this.host, `The box rejected this connection through ${this.host}. Reconnecting…`),
        );
        return;
      }
      this.#drop(socket, closeError(code, reason, this.host));
    };
    socket.onerror = () => this.#drop(socket, this.#lost());
  }

  #onHello(text: string): void {
    // Only a stable connection resets backoff; brief hello/close loops do not.
    let hello: Partial<BoxHello> = {};
    try {
      hello = JSON.parse(text) as BoxHello;
    } catch {
      // Fall through: an unparseable hello is handled as a wrong one.
    }
    const pub = typeof hello.pub === "string" ? fromBase64Url(hello.pub) : new Uint8Array(0);
    if (hello.t !== "hello" || hello.v !== RELAY_PROTOCOL || pub.length !== 32 || !this.#self) {
      const version = typeof hello.v === "number" ? `protocol v${hello.v}` : "something this app does not recognise";
      this.#rejectAll(
        new UnreachableError(
          "unknown",
          this.host,
          `The box answered the relay with ${version}; this app speaks v${RELAY_PROTOCOL}. Update the app or Shahi on that computer.`,
        ),
      );
      this.close();
      return;
    }
    this.#session = clientSession(this.#self, pub, this.target.secret);
    this.#receivedBytes = 0;
    this.#liveSince = Date.now();
    this.#self = null;
    // A device must prove its secret even when it only wants the dashboard.
    // A hello alone must never start a session or keep a phone slot alive.
    if (this.target.auth.kind === "device" && !this.#sendSealed({ t: "ws", data: this.#watching ? { type: "watch", paneId: this.#watching } : { type: "unwatch" } })) return;
    this.#setState("live");
    for (const pending of this.#pending.values()) if (!pending.sent) this.#dispatch(pending);
  }

  #receive(plain: Uint8Array): void {
    let msg: BoxToPhone;
    try {
      msg = JSON.parse(utf8.decode(plain)) as BoxToPhone;
    } catch {
      return; // A malformed frame is not worth tearing the link down for.
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "res") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return; // Answered after its timeout: nobody is waiting.
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      try {
        if (!Number.isInteger(msg.status) || msg.status < 100 || msg.status > 599 ||
            (msg.body !== null && typeof msg.body !== "string") ||
            !msg.headers || typeof msg.headers !== "object" || Array.isArray(msg.headers)) throw new Error("invalid response");
        pending.resolve(reply(msg));
      } catch {
        pending.reject(new UnreachableError("relay", this.host, "The box sent an invalid response."));
      }
    } else if (msg.t === "ws") {
      if (!msg.data || typeof msg.data !== "object" || typeof msg.data.type !== "string") return;
      if (msg.data.type === "ping") {
        // A quiet dashboard may never reach the bulk ACK threshold. Answer
        // heartbeats too, so a dead phone cannot retain a relay slot forever.
        const bytes = this.#receivedBytes; this.#receivedBytes = 0;
        if (bytes) this.#sendSealed({ t: "ack", bytes });
        return;
      }
      this.#subscribers.forEach((s) => s.onMessage(msg.data as SocketMessage));
    } else if (msg.t === "bye") {
      // The box is ending this link because our session is gone — revoked in
      // Settings, or expired. The relay could only close us with 1000, which
      // we would retry; this sealed signal is how that reaches the app,
      // exactly as a `/ws` close with 4001 does on a direct connection. Sign
      // out and stop, rather than reconnecting into a refusal forever.
      this.#refuse("This phone is no longer paired with that box.");
    }
  }

  #dispatch(pending: Pending): void {
    const { request } = pending;
    pending.sent = this.#sendSealed({
      t: "req",
      id: pending.id,
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: request.body ? toBase64Url(request.body) : null,
    });
  }

  #sendSealed(msg: PhoneToBox): boolean {
    const socket = this.#ws;
    if (!this.#session || !socket) return false;
    if (socket.readyState !== 1) { this.#drop(socket, this.#lost()); return false; }
    // `seal` returns a fresh, exact-length array, so a view is the frame:
    // React Native's `send` takes typed arrays as binary.
    try {
      const frame = seal(this.#session, utf8.encode(JSON.stringify(msg)));
      if (frame.byteLength > RELAY_LIMITS.maxFrameBytes) {
        this.#drop(socket, new UnreachableError("relay", this.host, "That message is too large for the relay."));
        return false;
      }
      if (socket.bufferedAmount + frame.byteLength > RELAY_LIMITS.maxSocketBufferedBytes) {
        this.#drop(socket, new UnreachableError("relay", this.host, "This connection is too slow. Reconnecting…"));
        return false;
      }
      socket.send(new Uint8Array(frame));
      return true;
    } catch {
      // Native WebSocket state can change between the readyState read and
      // send while a relay connection is dropping. React Native throws
      // INVALID_STATE_ERR in that race; let the close/retry path recover
      // instead of taking down the React error boundary.
      this.#drop(socket, this.#lost());
      return false;
    }
  }

  /** Not paired any more: stop for good and tell the app to sign out. */
  #refuse(words: string): void {
    this.#rejectAll(new UnauthorizedError(words));
    this.close();
    this.#subscribers.forEach((s) => s.onExpired?.());
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setState(state: LinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#subscribers.forEach((s) => s.onLink(state));
  }

  #checkAlive(): void {
    if (this.#closed || !this.#ws) return;
    if (this.#ws.readyState > 1) { this.#drop(this.#ws, this.#lost()); return; }
    if (!this.#session) return;
    if (Date.now() - this.#lastMessageAt < SILENCE_LIMIT_MS) return;
    this.#drop(this.#ws, this.#lost());
  }

  #lost(): Error { return new UnreachableError("lost", this.host, `The connection through ${this.host} dropped. Reconnecting…`); }

  #discard(socket: WebSocket): void {
    this.#ws = undefined; this.#session = null; this.#self = null; this.#confirmed = false;
    clearTimeout(this.#handshakeTimer); this.#handshakeTimer = undefined;
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
    try { socket.close(); } catch { /* Local recovery cannot depend on native close completing. */ }
  }

  #drop(socket: WebSocket, error: Error, immediate = false): void {
    if (this.#ws !== socket) return;
    if (this.#liveSince && Date.now() - this.#liveSince >= 30_000) this.#backoffMs = 500;
    this.#liveSince = 0;
    this.#discard(socket);
    this.#rejectAll(error);
    // Schedule before notifying: subscribers may immediately request a refresh.
    this.#retry(immediate);
    this.#setState("lost");
  }

  #retry(immediate = false): void {
    if (this.#closed || this.#timer) return;
    const delay = immediate ? 0 : retryDelay(this.#backoffMs, this.options.retryRandom);
    // Capped at half a minute, like the box's own dial: a phone that keeps
    // being refused is waiting for its box, and every attempt is a relay
    // request the box's owner pays for.
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }
}

/**
 * The relay's close codes, in words for the person holding the phone.
 *
 * 4429 covers three different refusals and the reason string tells them
 * apart; before it was read, a photo too big for one frame was reported as
 * "the relay is throttling this phone", and retrying failed the same way.
 */
function closeError(code: number, reason: string, host: string): UnreachableError {
  if (code === RELAY_CLOSE.boxOffline) {
    return new UnreachableError("box", host, "Your box is offline — its Shahi service is not connected to the relay.");
  }
  if (code === RELAY_CLOSE.quota) {
    if (reason === "frame too large") {
      return new UnreachableError("relay", host, `That was too big to send through the relay: one message carries up to ${humanSize(RELAY_LIMITS.maxBodyBytes)}.`);
    }
    if (reason === "too many phones") {
      return new UnreachableError("relay", host, "Too many connections are still open to this computer. Shahi will retry automatically.");
    }
    return new UnreachableError("relay", host, "The relay is throttling this phone. Wait a moment, then try again.");
  }
  return new UnreachableError("lost", host, `The connection through ${host} dropped. Try again.`);
}

/** Bytes as a person reads them: KB under a megabyte, so a cap of 783,360 is "765 KB" and not "0.7 MB". */
export function humanSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function reply(res: RelayResponse): Reply {
  const bytes = res.body ? fromBase64Url(res.body) : new Uint8Array(0);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: new Headers(res.headers),
    bytes: async () => bytes,
    text: async () => utf8.decode(bytes),
    json: async () => JSON.parse(utf8.decode(bytes)) as unknown,
  };
}

/* ------------------------------------------------------------- base64url */

// Written out rather than borrowed from `atob`/`btoa`: Hermes has neither
// without a polyfill, and the frames are bytes either way.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;
VALUES["+".charCodeAt(0)] = 62;
VALUES["/".charCodeAt(0)] = 63;

export function toBase64Url(bytes: Uint8Array): string {
  const parts: string[] = [];
  // Chunked so a photo does not become a million one-character concatenations.
  for (let start = 0; start < bytes.length; start += 3 * 1024) {
    const codes: number[] = [];
    const end = Math.min(bytes.length, start + 3 * 1024);
    for (let i = start; i < end; i += 3) {
      const a = bytes[i]!;
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
      codes.push(ALPHABET.charCodeAt((triple >> 18) & 63), ALPHABET.charCodeAt((triple >> 12) & 63));
      if (b !== undefined) codes.push(ALPHABET.charCodeAt((triple >> 6) & 63));
      if (c !== undefined) codes.push(ALPHABET.charCodeAt(triple & 63));
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

/** Accepts the standard alphabet and padding too, since a body may come from anywhere. */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(text)) throw new Error("relay: not base64url");
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1 || (text.includes("=") && text.length % 4 !== 0)) throw new Error("relay: not base64url");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? VALUES[code]! : -1;
    if (value < 0) throw new Error("relay: not base64url");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  if (bits && (acc & ((1 << bits) - 1)) !== 0) throw new Error("relay: not base64url");
  return out;
}

function secureRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
