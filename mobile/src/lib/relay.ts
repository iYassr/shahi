import { getRandomBytes } from "expo-crypto";
import { RelayLink as SharedRelayLink, type RelayTarget } from "@shahi/shared/relay-client";
export * from "@shahi/shared/relay-client";

/** Native CSPRNG adapter; protocol and transport are shared with the browser. */
export class RelayLink extends SharedRelayLink {
  constructor(target: RelayTarget) { super(target, { randomBytes: getRandomBytes }); }
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
