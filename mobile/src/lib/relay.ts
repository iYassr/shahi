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
 * frame. Randomness for the ephemeral key comes from `expo-crypto`, never
 * `Math.random`: the private half is what makes the exchange forward-secret.
 */
import { getRandomBytes } from "expo-crypto";
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
} from "@shahi/shared";
// A relative path on purpose: `@shahi/shared` exports only its index, and the
// e2e module is deliberately not re-exported through the types-only contract.
// Metro watches the workspace root, so the file is reachable at runtime.
import { clientSession, ephemeral, open, seal, type Ephemeral, type Session } from "../../../shared/src/e2e";
import { UnauthorizedError, UnreachableError, hostOf } from "./errors";

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
  #state: LinkState = "lost";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #backoffMs = 500;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #lastMessageAt = 0;
  #closed = false;
  #watching: string | null = null;
  #subscribers = new Set<LinkSubscriber>();
  readonly host: string;

  constructor(readonly target: RelayTarget) {
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
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#backoffMs = 500;
    this.#open();
  }

  /** Ends the link for good: a sign-out, or a target that changed under it. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#timer = undefined;
    this.#watchdog = undefined;
    const socket = this.#ws;
    this.#ws = undefined;
    this.#session = null;
    if (socket) {
      // Detach first: the close handler would otherwise schedule a retry.
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
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

    const url = `${this.target.relay.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/phone/${this.target.serverId}`;
    const socket = new WebSocket(url);
    // Sealed frames are bytes. Left on the default, React Native hands each
    // one over as a Blob that has to be read back asynchronously.
    socket.binaryType = "arraybuffer";
    this.#ws = socket;

    socket.onopen = () => {
      // The backoff is reset on the box's hello, not here: a refused link
      // (a ninth phone, a box that is offline) *opens* and then closes with
      // a code, and resetting on open made the phone knock every ~0.8s for
      // as long as the app was up — ~100k relay requests a day from one
      // phone, the free plan's whole quota (measured, 2026-09-02).
      this.#lastMessageAt = Date.now();
      // A fresh key per connection is what makes a leaked secret useless
      // against past sessions; the bytes come from the platform's CSPRNG.
      this.#self = ephemeral(getRandomBytes(32));
      const hello: PhoneHello = { t: "hello", v: RELAY_PROTOCOL, pub: toBase64Url(this.#self.pub), auth: this.target.auth };
      // Bytes, not text: the relay forwards data frames and drops text from
      // phones, which is relay control. The box answers the same way.
      socket.send(utf8.encode(JSON.stringify(hello)));
    };
    socket.onmessage = (event: { data: unknown }) => {
      this.#lastMessageAt = Date.now();
      if (typeof event.data === "string") {
        // The relay sends phones no text; whatever this is, it is not ours.
        return;
      }
      if (!this.#session) {
        // The first data frame is the box's hello, in the clear.
        this.#onHello(utf8.decode(new Uint8Array(event.data as ArrayBuffer)));
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
        this.#rejectAll(new UnreachableError("lost", this.host, `The secure connection through ${this.host} changed. Reconnecting…`));
        this.#setState("lost");
        this.#session = null;
        socket.close();
        return;
      }
      this.#receive(plain);
    };
    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (this.#ws !== socket) return;
      this.#ws = undefined;
      this.#session = null;
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
        this.#rejectAll(
          new UnreachableError("lost", this.host, `The box rejected this connection through ${this.host}. Reconnecting…`),
        );
        this.#setState("lost");
        this.#retry();
        return;
      }
      this.#rejectAll(closeError(code, reason, this.host));
      this.#setState("lost");
      this.#retry();
    };
    socket.onerror = () => socket.close();
  }

  #onHello(text: string): void {
    // The box answered: this link is real, so the next drop starts over.
    this.#backoffMs = 500;
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
    this.#self = null;
    this.#setState("live");
    if (this.#watching) this.watch(this.#watching);
    for (const pending of this.#pending.values()) if (!pending.sent) this.#dispatch(pending);
  }

  #receive(plain: Uint8Array): void {
    let msg: BoxToPhone;
    try {
      msg = JSON.parse(utf8.decode(plain)) as BoxToPhone;
    } catch {
      return; // A malformed frame is not worth tearing the link down for.
    }
    if (msg.t === "res") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return; // Answered after its timeout: nobody is waiting.
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(reply(msg));
    } else if (msg.t === "ws") {
      // The heartbeat's only job is the timestamp the watchdog reads.
      if (msg.data.type === "ping") return;
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
    if (!this.#session || !socket || socket.readyState !== 1) return false;
    // `seal` returns a fresh, exact-length array, so a view is the frame:
    // React Native's `send` takes typed arrays as binary.
    try {
      socket.send(seal(this.#session, utf8.encode(JSON.stringify(msg))));
      return true;
    } catch {
      // Native WebSocket state can change between the readyState read and
      // send while a relay connection is dropping. React Native throws
      // INVALID_STATE_ERR in that race; let the close/retry path recover
      // instead of taking down the React error boundary.
      if (this.#ws === socket) socket.close();
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
    if (this.#closed || !this.#session || this.#ws?.readyState !== 1) return;
    if (Date.now() - this.#lastMessageAt < SILENCE_LIMIT_MS) return;
    this.#setState("lost");
    this.#ws.close();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    const delay = this.#backoffMs;
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
      return new UnreachableError("relay", host, `This box already has ${RELAY_LIMITS.maxPhonesPerBox} phones on the relay. Revoke one in Settings on another phone.`);
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

/* ------------------------------------------------------------ the one link */

let current: { target: RelayTarget; link: RelayLink } | null = null;

/**
 * The link for the connection the app is on, opened on first use.
 *
 * One link is both the request channel and the dashboard stream, so requests
 * and the socket must share it — and a request can come before any socket
 * exists (the pairing handshake, a cold-start refresh). Keyed by the target
 * object's identity: a new target, set by pairing or sign-in, retires the old
 * link the next time anything asks.
 */
export function relayLink(target: RelayTarget): RelayLink {
  if (current?.target !== target) {
    current?.link.close();
    current = { target, link: new RelayLink(target) };
  }
  return current.link;
}

/** Sign-out: the link goes with the credentials. */
export function closeRelay(): void {
  current?.link.close();
  current = null;
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
  const clean = text.replace(/=+$/, "");
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
  return out;
}
