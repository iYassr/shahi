/**
 * What a failed request means, below the transport.
 *
 * These lived in `api.ts` until the relay transport needed to throw them too:
 * a relay close code is the same three outcomes — signed out, incompatible,
 * unreachable — arriving as a WebSocket close instead of an HTTP status, and
 * `relay.ts` cannot import `api.ts` for them without a cycle (`api.ts` is what
 * imports the transport). The screens keep importing them from `@/lib/api`,
 * which re-exports this module.
 */

export class UnauthorizedError extends Error {
  /**
   * The message defaults to the old fixed word because most callers only test
   * the class — a 401 is a sign-out, not something to read. The relay passes
   * words through, because there a refusal can reach the Connect screen during
   * pairing, where "unauthorized" would explain nothing.
   */
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The server answered and refused: its words, the HTTP status, and the
 * machine-readable code it sent with them (`prompt_gone`, `backend_unavailable`…).
 *
 * The native client used to keep only the words, so a screen could not tell
 * a question that had already closed from a relay timeout, or a pane that no
 * longer exists from one that has not written a transcript yet.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The server and this app do not speak a common contract version.
 *
 * Distinct from unreachable and from unauthorized: the server is there and
 * answering, it just cannot be talked to by this build. The message says which
 * side to update, because "update" alone sends people to the wrong device.
 */
export class IncompatibleServerError extends Error {
  constructor(
    message: string,
    readonly serverApi: { min: number; max: number },
  ) {
    super(message);
    this.name = "IncompatibleServerError";
  }
}

export type UnreachableReason =
  | "address"
  | "ats"
  | "dns"
  | "refused"
  | "offline"
  | "lost"
  | "timeout"
  | "tls"
  /** The relay answered, and said no box is connected for this id. */
  | "box"
  /** The relay itself refused the phone — its quota, for now. */
  | "relay"
  | "unknown";

/**
 * The server could not be reached at all — as opposed to reached and refusing.
 *
 * `fetch` rejects with whatever the platform said. On iOS that is Expo wrapping
 * an NSURLError description — "fetch failed: UnexpectedException: A server
 * with the specified hostname could not be found. (at
 * ExpoModulesCore/Promise.swift:56)" — and that string reached the Connect
 * screen and the Agents screen verbatim, reading as a crash rather than a
 * network. This carries a message written for the person holding the phone,
 * naming the host they typed, and a `reason` so a screen can decide what to
 * offer.
 */
export class UnreachableError extends Error {
  constructor(
    readonly reason: UnreachableReason,
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "UnreachableError";
  }
}

/**
 * An SSH server did not present the host key this phone trusts for it, or
 * this phone trusts none for it yet, so no login was sent.
 *
 * Only the native app speaks SSH. This lives here because `connectionHealth`,
 * which both clients share, words every connection state: a saved computer
 * whose server was reinstalled sat on "Reconnecting…" for good, because the
 * refusal's own words, which say what to do, never reached the screen (seen on
 * a simulator during the pre-release review).
 */
export class HostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostKeyError";
  }
}

/**
 * The code of the 409 a prompt, an answer or key presses get when the pane now
 * runs a different program from the one they were meant for, so the server
 * sent nothing. herdr reuses pane ids, so a draft or a retried send can
 * outlive the pane it was typed for; the pre-release bug hunt had one typed
 * into a new shell. The response's message says so in words a client shows as
 * they stand.
 */
export const PANE_REPLACED = "pane_replaced";

/**
 * `host:port` of a URL, for messages. A regex rather than `URL`, because a
 * malformed address is one of the cases being described and must produce a
 * message rather than a second exception.
 */
export function hostOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
}
