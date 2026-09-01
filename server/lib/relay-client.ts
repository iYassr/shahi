/**
 * The box's half of the blind relay (`docs/relay.md`).
 *
 * One outbound WebSocket to the relay, held open forever: the relay challenges,
 * the box signs with its identity, and from then on every phone that reaches
 * the relay under this box's id arrives as a numbered **link** on this one
 * socket. Nothing is opened on the box, and the relay never learns a key, a
 * path or a byte of a terminal — it forwards frames it cannot read.
 *
 * Each link is a phone: a hello in the clear naming a device or a pairing
 * code, then sealed frames on keys only that phone and this box can derive
 * (`shared/src/e2e.ts`). Inside the seal, a link is both a request channel and
 * the dashboard stream, and the rest of the server does not know the
 * difference: a request becomes an in-process `Request` for the same handler
 * the port serves, and the link is registered with the HTTP layer as a
 * `StreamClient`, so `session`, `frame`, `log_changed` and the rest reach it
 * exactly as they reach a `/ws` socket. A revoked device closes its links the
 * same way it closes its sockets.
 *
 * Logged: connection state and link opens and closes. Never a frame.
 */
import {
  BOX_AUTH_PREFIX,
  LINK_PREFIX_BYTES,
  RELAY_LIMITS,
  RELAY_PROTOCOL,
  type BoxHello,
  type BoxToPhone,
  type BoxToRelay,
  type PhoneHello,
  type PhoneToBox,
  type RelayRequest,
  type RelayToBox,
} from "@shahi/shared";
import { PUBLIC_KEY_LEN, ephemeral, open, seal, serverSession, type Session } from "@shahi/shared/e2e";
import { SESSION_COOKIE, type Auth } from "./auth";
import type { ShahiServer, SocketData, StreamClient } from "./http";
import type { ServerIdentity } from "./identity";
import type { Devices, Pairing } from "./pairing";

export interface RelayClientDeps {
  /** `RELAY_URL`: http(s), the Worker's address. */
  url: string;
  identity: ServerIdentity;
  devices: Pick<Devices, "secret">;
  pairing: Pick<Pairing, "secretByHash">;
  auth: Pick<Auth, "issue">;
  server: Pick<ShahiServer, "dispatch" | "attach" | "detach" | "receive">;
  log?: (line: string) => void;
}

export interface RelayClientOptions {
  /** First retry delay after a drop; doubles to `maxBackoffMs`. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long to wait for `ready` before treating the connection as dead. */
  authTimeoutMs?: number;
  /**
   * How often to send the relay a text `ping` once ready. The Workers runtime
   * cannot originate a ping from a Durable Object, so liveness is the box's
   * job: the relay answers `pong` without waking, and drops a box silent for
   * five minutes. Sixty seconds leaves four misses before that.
   */
  pingMs?: number;
}

/** The response headers a `res` carries; everything else stays on the box. */
const RESPONSE_HEADERS = ["content-type", "etag", "cache-control"] as const;

/**
 * Request headers a phone cannot set through a link. The session is the
 * link's own (minted at hello, bound to its device), the Origin check is
 * satisfied by having no Origin, and the forwarded-for headers would let a
 * link choose its rate-limit bucket.
 */
const REQUEST_HEADERS_DROPPED = new Set(["cookie", "origin", "host", "x-forwarded-for", "x-forwarded-host"]);

/**
 * The largest response body a `res` can carry inside one relay frame: the
 * relay's limit less room for the seal, the JSON around it and base64url's
 * expansion. A bigger one — a large file from `/api/file` — is answered 413
 * here rather than dropped by the relay with the link.
 */
const MAX_RESPONSE_BODY_BYTES = Math.floor(((RELAY_LIMITS.maxFrameBytes - 4096) * 3) / 4);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export class RelayClient {
  readonly #deps: RelayClientDeps;
  readonly #log: (line: string) => void;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #authTimeoutMs: number;

  #ws: WebSocket | null = null;
  #ready = false;
  #stopped = true;
  #backoffMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  readonly #pingMs: number;
  readonly #links = new Map<number, Link>();

  constructor(deps: RelayClientDeps, options: RelayClientOptions = {}) {
    this.#deps = deps;
    this.#log = deps.log ?? ((line) => console.log(line));
    this.#minBackoffMs = options.minBackoffMs ?? 500;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#authTimeoutMs = options.authTimeoutMs ?? RELAY_LIMITS.boxAuthTimeoutMs;
    this.#pingMs = options.pingMs ?? 60_000;
    this.#backoffMs = this.#minBackoffMs;
  }

  /** Authenticated and holding the socket the relay will send phones on. */
  get connected(): boolean {
    return this.#ready;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    this.#releaseAll();
    this.#ws?.close(1001, "shutting down");
    this.#ws = null;
    this.#ready = false;
  }

  #connect(): void {
    const ws = new WebSocket(boxUrl(this.#deps.url, this.#deps.identity.serverId));
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#ready = false;

    // The relay closes an unauthenticated box after ten seconds; this is the
    // same limit from our side, for a relay that accepted the socket and then
    // said nothing — a half-open connection would otherwise look like a
    // healthy one forever.
    const authTimer = setTimeout(() => {
      if (this.#ws === ws && !this.#ready) {
        this.#log(`relay: no ready within ${this.#authTimeoutMs}ms, redialling`);
        ws.close(4000, "auth timeout");
      }
    }, this.#authTimeoutMs);

    ws.onmessage = (event) => {
      if (this.#ws !== ws) return;
      if (typeof event.data === "string") this.#control(ws, event.data);
      else this.#frame(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onerror = () => {
      // A close event follows every error; that is where the retry lives.
    };
    ws.onclose = (event) => {
      clearTimeout(authTimer);
      if (this.#ws !== ws) return;
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
      this.#ws = null;
      const wasReady = this.#ready;
      this.#ready = false;
      this.#releaseAll();
      if (this.#stopped) return;
      this.#log(
        `relay: ${wasReady ? "disconnected" : "could not connect"} (${event.code}${event.reason ? ` ${event.reason}` : ""}), retrying in ${this.#backoffMs}ms`,
      );
      this.#reconnectTimer = setTimeout(() => this.#connect(), this.#backoffMs);
      this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs);
    };
  }

  #control(ws: WebSocket, text: string): void {
    let msg: RelayToBox;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case "challenge": {
        const { identity } = this.#deps;
        const signed = encoder.encode(BOX_AUTH_PREFIX + identity.serverId + msg.nonce);
        const auth: BoxToRelay = { t: "auth", pub: b64(identity.publicKey), sig: b64(identity.sign(signed)) };
        ws.send(JSON.stringify(auth));
        return;
      }
      case "ready":
        this.#ready = true;
        this.#backoffMs = this.#minBackoffMs;
        this.#log(`relay: connected to ${this.#deps.url} as ${this.#deps.identity.serverId}`);
        clearInterval(this.#pingTimer);
        this.#pingTimer = setInterval(() => {
          if (this.#ws === ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, this.#pingMs);
        return;
      case "open":
        // A relay reusing a number still held here is a relay that lost track;
        // whatever that link was, it is gone.
        this.#links.get(msg.link)?.release();
        this.#links.set(msg.link, new Link(msg.link, this.#wire, this.#deps, this.#log));
        this.#log(`relay: link ${msg.link} opened`);
        return;
      case "close":
        this.#links.get(msg.link)?.release();
        this.#links.delete(msg.link);
        this.#log(`relay: link ${msg.link} closed by the phone`);
        return;
    }
  }

  #frame(bytes: Uint8Array): void {
    if (bytes.length < LINK_PREFIX_BYTES) return;
    const link = new DataView(bytes.buffer, bytes.byteOffset, LINK_PREFIX_BYTES).getUint32(0, false);
    this.#links.get(link)?.receive(bytes.subarray(LINK_PREFIX_BYTES));
  }

  /** What a link can do to the socket: send a frame on its number, or end itself. */
  readonly #wire: Wire = {
    send: (link, payload) => {
      const ws = this.#ws;
      if (!ws || !this.#ready) return;
      const frame = new Uint8Array(LINK_PREFIX_BYTES + payload.length);
      new DataView(frame.buffer).setUint32(0, link, false);
      frame.set(payload, LINK_PREFIX_BYTES);
      ws.send(frame);
    },
    end: (link) => {
      this.#links.delete(link);
      const message: BoxToRelay = { t: "close", link };
      if (this.#ws && this.#ready) this.#ws.send(JSON.stringify(message));
    },
  };

  #releaseAll(): void {
    for (const link of this.#links.values()) link.release();
    this.#links.clear();
  }
}

interface Wire {
  send(link: number, payload: Uint8Array): void;
  end(link: number): void;
}

/**
 * One phone, from the relay's `open` to its `close`.
 *
 * Implements `StreamClient` so the HTTP layer pushes to it and closes it as it
 * would a socket: `send` seals the push as `{"t":"ws","data":…}`, `close`
 * ends the link. `data` is the same record a socket carries — the device
 * behind it (so revoking closes it) and the token the heartbeat re-verifies.
 */
class Link implements StreamClient {
  readonly data: SocketData = { deviceId: null, watchedPaneId: null, releaseWatch: null, releaseLog: null, token: undefined };

  #session: Session | null = null;
  #kind: PhoneHello["auth"]["kind"] | null = null;
  #rateKey = "";
  #attached = false;
  #released = false;

  constructor(
    readonly id: number,
    private readonly wire: Wire,
    private readonly deps: RelayClientDeps,
    private readonly log: (line: string) => void,
  ) {}

  receive(payload: Uint8Array): void {
    if (this.#released) return;
    if (!this.#session) {
      this.#hello(payload);
      return;
    }

    let plain: Uint8Array;
    try {
      plain = open(this.#session, payload);
    } catch {
      // The other side does not hold the secret, or is replaying. Either way
      // this link cannot continue; closing it is the signal (`4403` is what
      // the relay would say, but from the box the close is the message).
      this.end("a frame did not open");
      return;
    }

    let msg: PhoneToBox;
    try {
      msg = JSON.parse(decoder.decode(plain));
    } catch {
      this.end("a frame was not JSON");
      return;
    }
    if (msg.t === "req") {
      // Not awaited: requests on a link are concurrent and answered by id.
      void this.#request(msg);
    } else if (msg.t === "ws" && this.#attached) {
      this.deps.server.receive(this, msg.data);
    }
  }

  #hello(payload: Uint8Array): void {
    const hello = parseHello(payload);
    if (!hello) {
      this.end("a malformed hello");
      return;
    }

    // The secret never travels: the hello names it, and only a box that has
    // it can derive the keys the phone is about to use.
    const secret =
      hello.auth.kind === "device"
        ? this.deps.devices.secret(hello.auth.deviceId)
        : this.deps.pairing.secretByHash(hello.auth.id);
    if (!secret) {
      this.end(hello.auth.kind === "device" ? "unknown device" : "unknown pairing code");
      return;
    }

    const self = ephemeral(crypto.getRandomValues(new Uint8Array(32)));
    this.#session = serverSession(self, unb64(hello.pub), secret);
    this.#kind = hello.auth.kind;
    const answer: BoxHello = { t: "hello", v: RELAY_PROTOCOL, pub: b64(self.pub) };
    this.wire.send(this.id, encoder.encode(JSON.stringify(answer)));

    if (hello.auth.kind === "device") {
      // The link *is* this device: one token for its lifetime, bound to the
      // device id, attached to every request — so the gate, revocation and the
      // 426 check run in the HTTP layer unchanged.
      this.data.deviceId = hello.auth.deviceId;
      this.data.token = this.deps.auth.issue(Date.now(), hello.auth.deviceId);
      this.#rateKey = `relay:${hello.auth.deviceId}`;
      this.deps.server.attach(this);
      this.#attached = true;
    } else {
      // A pairing link gets no session and no stream: it may claim, and that
      // is all, until it comes back as the device the claim made.
      this.#rateKey = `relay:pair:${hello.auth.id}`;
    }
  }

  async #request(req: RelayRequest): Promise<void> {
    // A pairing link may look at `/api/meta` (unauthenticated over HTTP too:
    // the phone checks the serverId in the code against the box it reached
    // before it hands over the secret) and claim. Nothing else.
    const allowed =
      (req.method === "GET" && req.path.split("?")[0] === "/api/meta") ||
      (req.method === "POST" && req.path === "/api/pair/claim");
    if (this.#kind === "pairing" && !allowed) {
      this.#answer(req.id, jsonResponse(403, { error: "a pairing link may only read /api/meta and claim its code" }));
      return;
    }

    let request: Request;
    try {
      request = buildRequest(req, this.data.token);
    } catch {
      this.#answer(req.id, jsonResponse(400, { error: "malformed request" }));
      return;
    }

    let response: Response;
    try {
      response = await this.deps.server.dispatch(request, this.#rateKey);
    } catch (err) {
      this.#answer(req.id, jsonResponse(500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    this.#answer(req.id, response);
  }

  #answer(id: number, response: Response): void {
    void (async () => {
      let body = new Uint8Array(await response.arrayBuffer());
      let { status } = response;
      const headers: Record<string, string> = {};
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      if (body.length > MAX_RESPONSE_BODY_BYTES) {
        status = 413;
        headers["content-type"] = "application/json";
        body = encoder.encode(JSON.stringify({ error: "too large to send through the relay" }));
      }
      const res: BoxToPhone = { t: "res", id, status, headers, body: body.length > 0 ? b64(body) : null };
      this.#sendSealed(JSON.stringify(res));
    })();
  }

  /* ------------------------------------------------------- StreamClient */

  send(payload: string): void {
    // `payload` is one JSON object, already serialised by the broadcaster;
    // wrapping it as text avoids parsing it only to stringify it again.
    this.#sendSealed(`{"t":"ws","data":${payload}}`);
  }

  close(_code: number, reason: string): void {
    this.end(reason);
  }

  /* ---------------------------------------------------------- lifecycle */

  /** Ends the link from this side: tells the relay, releases what it held. */
  end(reason: string): void {
    if (this.#released) return;
    this.log(`relay: link ${this.id} closed (${reason})`);
    this.wire.end(this.id);
    this.release();
  }

  /** The link is gone (the relay said so, or the socket dropped): let go of everything it held. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#attached) {
      this.#attached = false;
      this.deps.server.detach(this);
    }
  }

  #sendSealed(text: string): void {
    if (this.#released || !this.#session) return;
    this.wire.send(this.id, seal(this.#session, encoder.encode(text)));
  }
}

/* -------------------------------------------------------------------------- */

/** `${RELAY_URL}/v1/box/${serverId}`, over ws(s). */
export function boxUrl(relayUrl: string, serverId: string): string {
  const base = relayUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  return `${base}/v1/box/${serverId}`;
}

/** The hello, or null for anything that is not one — a malformed first frame is never guessed at. */
function parseHello(payload: Uint8Array): PhoneHello | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const hello = value as Partial<PhoneHello>;
  if (hello.t !== "hello" || hello.v !== RELAY_PROTOCOL || typeof hello.pub !== "string") return null;
  if (unb64(hello.pub).length !== PUBLIC_KEY_LEN) return null;
  const auth = hello.auth as Partial<PhoneHello["auth"]> | undefined;
  if (typeof auth !== "object" || auth === null) return null;
  if (auth.kind === "device" && typeof auth.deviceId === "string" && auth.deviceId !== "") return hello as PhoneHello;
  if (auth.kind === "pairing" && typeof auth.id === "string" && auth.id !== "") return hello as PhoneHello;
  return null;
}

/** The in-process request a `req` becomes. Throws for anything `Request` refuses. */
function buildRequest(req: RelayRequest, token: string | undefined): Request {
  if (typeof req.path !== "string" || !req.path.startsWith("/")) throw new Error("path");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === "string" && !REQUEST_HEADERS_DROPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  const body = typeof req.body === "string" ? unb64(req.body) : null;
  return new Request(`http://relay.local${req.path}`, { method: req.method, headers, body });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
