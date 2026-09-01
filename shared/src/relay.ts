/**
 * The blind relay's wire shapes — see `docs/relay.md`, which is the protocol.
 *
 * Three programs speak this: the Worker in `relay/`, the sidecar's relay
 * client, and the app's relay transport. They are built separately and meet
 * on these types, so nothing here is optional or inferred.
 */
import type { SocketMessage } from "./index";

/** Bump together with `docs/relay.md` when a frame changes shape. */
export const RELAY_PROTOCOL = 1;

/** What a box signs to prove it owns its `serverId`: this prefix, then the id, then the nonce, as UTF-8. */
export const BOX_AUTH_PREFIX = "shahi-relay-box-v1";

/* ------------------------------------------------- relay ↔ box (text frames) */

export type RelayToBox =
  | { t: "challenge"; nonce: string }
  | { t: "ready" }
  | { t: "open"; link: number }
  | { t: "close"; link: number };

export type BoxToRelay =
  | { t: "auth"; pub: string; sig: string }
  | { t: "close"; link: number };

/** Bytes prefixed to every data frame on the box side: the link number, big-endian. */
export const LINK_PREFIX_BYTES = 4;

/* ------------------------------------------------------ relay close codes */

export const RELAY_CLOSE = {
  /** Box authentication failed or timed out; phone hello named nothing the box knows. */
  unauthorized: 4401,
  /** The first sealed frame did not open: the other side does not hold the secret. */
  forbidden: 4403,
  /** No box is connected for this serverId. */
  boxOffline: 4404,
  /** A newer box connection replaced this one. */
  replaced: 4409,
  /** The relay's quota for this phone or box was exceeded. */
  quota: 4429,
} as const;

/* ------------------------------------------------------------ relay limits */

export const RELAY_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxPhonesPerBox: 8,
  /** Sustained bytes per second per phone, and the burst it may bank. */
  phoneBytesPerSecond: 64 * 1024,
  phoneBurstBytes: 1024 * 1024,
  phoneIdleMs: 10 * 60_000,
  boxAuthTimeoutMs: 10_000,
} as const;

/* --------------------------------------------- phone ↔ box, before sealing */

/**
 * The phone's first frame on a link, in the clear: who it claims to be, and its
 * ephemeral key. Sent as the UTF-8 bytes of the JSON in a *binary* frame — the
 * relay forwards data frames only and drops text from phones.
 */
export interface PhoneHello {
  t: "hello";
  v: typeof RELAY_PROTOCOL;
  /** base64url, 32 bytes: X25519 ephemeral public key. */
  pub: string;
  auth:
    | { kind: "device"; deviceId: string }
    /** `id` is base64url(sha256(pairing secret)); the secret itself never travels. */
    | { kind: "pairing"; id: string };
}

/** The box's answer, the same way (JSON bytes in a binary frame): its ephemeral key. Everything after this is sealed. */
export interface BoxHello {
  t: "hello";
  v: typeof RELAY_PROTOCOL;
  pub: string;
}

/* ---------------------------------------------- phone ↔ box, inside a seal */

/** A request, tunnelled. `body` is base64url of the bytes, or null. */
export interface RelayRequest {
  t: "req";
  id: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Its answer. `headers` is limited to content-type, etag and cache-control. */
export interface RelayResponse {
  t: "res";
  id: number;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** The dashboard stream in either direction, exactly as `/ws` would carry it. */
export interface RelayStream {
  t: "ws";
  data: SocketMessage | { type: "watch"; paneId: string } | { type: "unwatch" };
}

export type PhoneToBox = RelayRequest | RelayStream;
export type BoxToPhone = RelayResponse | RelayStream;

/** What `POST /api/pair/claim` answers over a pairing link (and over HTTP, additively). */
export interface ClaimResult {
  ok: true;
  deviceId: string;
  /** base64url, 32 bytes: the phone's long-lived share of the E2E key for this box. */
  deviceSecret: string;
}
