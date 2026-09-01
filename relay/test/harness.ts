/**
 * Runs the relay under `wrangler dev` for the tests, and speaks to it as a box
 * or a phone would. Nothing here needs a Cloudflare account: `wrangler dev`
 * runs the Worker in workerd on this machine, Durable Objects, hibernation and
 * alarms included.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { BOX_AUTH_PREFIX, type BoxToRelay, type RelayToBox } from "@shahi/shared";

export const PORT = 8787;
export const HTTP = `http://127.0.0.1:${PORT}`;
export const WS = `ws://127.0.0.1:${PORT}`;

const RELAY_DIR = new URL("..", import.meta.url).pathname;

/**
 * Starts `wrangler dev` and returns a function that stops it. Waits for the
 * front door to answer 404 — a listening port is not enough, wrangler binds
 * it before the Worker is built.
 *
 * stdout is discarded rather than piped: on this Mac, Bun's test runner fails
 * any `Bun.spawn` with a piped stdio (EBADF), see `docs/on-a-mac.md`.
 */
export async function startRelay(): Promise<() => void> {
  // A relay already on the port (a `wrangler dev` left running to iterate
  // against) is used as is, and left running.
  if (await answers()) return () => {};
  const proc = Bun.spawn(
    ["bunx", "wrangler", "dev", "--port", String(PORT), "--inspector-port", "0", "--log-level", "warn"],
    {
      cwd: RELAY_DIR,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited with ${proc.exitCode}`);
    if (await answers()) return () => proc.kill();
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("wrangler dev did not come up within 90s");
}

async function answers(): Promise<boolean> {
  try {
    return (await fetch(`${HTTP}/`)).status === 404;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- identities */

export interface Box {
  priv: Uint8Array;
  pub: Uint8Array;
  serverId: string;
}

/** A fresh keypair and the serverId it hashes to — a new Durable Object every time, so tests cannot see each other. */
export function newBox(): Box {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub, serverId: b64url(sha256(pub)) };
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/* ----------------------------------------------------------------- sockets */

export interface Closed {
  code: number;
  reason: string;
}

/** A WebSocket with its inbound frames queued, so a test can await the next one. */
export class Peer {
  private frames: (string | Uint8Array)[] = [];
  private waiters: ((frame: string | Uint8Array) => void)[] = [];
  readonly closed: Promise<Closed>;
  private settle!: (c: Closed) => void;
  readonly ws: WebSocket;

  constructor(url: string) {
    this.closed = new Promise((resolve) => (this.settle = resolve));
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    this.ws.addEventListener("close", (event) => this.settle({ code: event.code, reason: event.reason }));
  }

  /** The next frame, or a failure after `ms` — a hung test should say what it was waiting for. */
  next(ms = 5_000): Promise<string | Uint8Array> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (frame: string | Uint8Array) => {
        clearTimeout(timer);
        resolve(frame);
      };
      // A waiter that timed out must leave the queue, or the next frame is
      // handed to it and lost: `hears()` relies on this.
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`no frame within ${ms}ms`));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  async text(): Promise<RelayToBox> {
    const frame = await this.next();
    if (typeof frame !== "string") throw new Error("expected a text frame, got binary");
    return JSON.parse(frame) as RelayToBox;
  }

  /** The nonce from the challenge that must be the first thing a box hears. */
  async challenge(): Promise<string> {
    const frame = await this.text();
    if (frame.t !== "challenge") throw new Error(`expected challenge, got ${frame.t}`);
    return frame.nonce;
  }

  async binary(): Promise<Uint8Array> {
    const frame = await this.next();
    if (typeof frame === "string") throw new Error(`expected a binary frame, got text: ${frame}`);
    return frame;
  }

  /** Resolves true if a frame arrives within `ms`, false otherwise: for asserting that nothing was forwarded. */
  async hears(ms = 300): Promise<boolean> {
    try {
      this.frames.unshift(await this.next(ms));
      return true;
    } catch {
      return false;
    }
  }

  send(data: string | Uint8Array | Record<string, unknown>): void {
    if (typeof data === "string" || data instanceof Uint8Array) this.ws.send(data);
    else this.ws.send(JSON.stringify(data));
  }

  close(): void {
    this.ws.close();
  }

  static async open(url: string): Promise<Peer> {
    const peer = new Peer(url);
    await new Promise<void>((resolve, reject) => {
      peer.ws.addEventListener("open", () => resolve());
      peer.ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
      // A refused socket (4404, 4429) closes before it opens, from the client's
      // view; let the test read the code instead of failing here.
      peer.closed.then(() => resolve());
    });
    return peer;
  }
}

/** The box side of a relay connection, up to and including `ready`. */
export async function connectBox(box: Box): Promise<Peer> {
  const peer = await Peer.open(`${WS}/v1/box/${box.serverId}`);
  peer.send(signAuth(box, await peer.challenge()));
  const ready = await peer.text();
  if (ready.t !== "ready") throw new Error(`expected ready, got ${ready.t}`);
  return peer;
}

export function signAuth(box: Box, nonce: string, serverId = box.serverId): BoxToRelay {
  const message = new TextEncoder().encode(BOX_AUTH_PREFIX + serverId + nonce);
  return { t: "auth", pub: b64url(box.pub), sig: b64url(ed25519.sign(message, box.priv)) };
}

export function connectPhone(box: Box): Promise<Peer> {
  return Peer.open(`${WS}/v1/phone/${box.serverId}`);
}

/** Splits a box-side data frame into its link number and payload. */
export function unframe(frame: Uint8Array): { link: number; payload: Uint8Array } {
  return {
    link: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0),
    payload: frame.slice(4),
  };
}
