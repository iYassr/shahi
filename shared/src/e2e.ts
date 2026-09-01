/**
 * End-to-end encryption for the phone↔server channel.
 *
 * When the transport is a public tunnel (Cloudflare), TLS terminates at the
 * vendor's edge, so the vendor would see the plaintext. Since `pane.send_text`
 * is arbitrary shell execution, a relay that can read or inject into this
 * channel is a remote-code-execution surface. So the payload is encrypted here,
 * above the transport, with a key only the phone and the server hold — the
 * tunnel only ever brokers ciphertext. See `docs/connectivity.md`.
 *
 * The construction, chosen to be small and auditable rather than clever:
 *
 *  - A **pairing secret** (32 random bytes, carried in the QR) is the only
 *    long-lived shared value.
 *  - Each connection does an **ephemeral X25519** handshake, and the pairing
 *    secret is mixed into the key derivation (HKDF ikm = ECDH‖secret). That mix
 *    is what authenticates the exchange: a man in the middle without the pairing
 *    secret derives a different key and every decrypt fails. Because the DH keys
 *    are ephemeral, a pairing secret that leaks *later* does not expose past
 *    sessions — forward secrecy.
 *  - Messages are sealed with **ChaCha20-Poly1305**, a separate key per
 *    direction, and a per-message counter as the nonce. Different key per
 *    direction plus a monotonic counter means a nonce is never reused; the
 *    counter travels with the message and a receiver rejects any counter it has
 *    already passed, so a replayed frame is refused.
 *
 * This module is deliberately platform-neutral: it imports only pure-JS crypto
 * and takes randomness as a parameter, so the same code runs in the Bun server
 * and the React Native app. Neither `node:` nor `bun:` nor `expo-*` appears
 * here; the caller supplies 32 random bytes for the ephemeral key.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const HKDF_INFO = new TextEncoder().encode("shahi/e2e/v1");
const KEY_LEN = 32;
export const PAIRING_SECRET_LEN = 32;
export const PUBLIC_KEY_LEN = 32;

/** One direction's key and its running nonce counter. */
interface Channel {
  key: Uint8Array;
  next: bigint;
}

/**
 * A live encrypted session: the keys derived for this connection, plus the send
 * and receive counters. Mutable — `seal`/`open` advance the counters.
 */
export interface Session {
  send: Channel;
  recv: Channel;
}

/** An ephemeral keypair. `priv` never leaves the device; `pub` is sent once. */
export interface Ephemeral {
  priv: Uint8Array;
  pub: Uint8Array;
}

/**
 * Derives an ephemeral keypair from 32 caller-supplied random bytes.
 *
 * Randomness is injected rather than read from a global so this module stays
 * platform-neutral: the server passes `crypto.getRandomValues`, the app passes
 * `expo-crypto`'s bytes. Reusing a private key across connections would sacrifice
 * forward secrecy, so callers must pass fresh randomness each time.
 */
export function ephemeral(random32: Uint8Array): Ephemeral {
  if (random32.length < 32) throw new Error("e2e: need 32 random bytes for an ephemeral key");
  const priv = random32.slice(0, 32);
  return { priv, pub: x25519.getPublicKey(priv) };
}

function deriveMaster(
  shared: Uint8Array,
  pairingSecret: Uint8Array,
  clientPub: Uint8Array,
  serverPub: Uint8Array,
): { c2s: Uint8Array; s2c: Uint8Array } {
  // ikm binds the pairing secret to the ECDH result — this is the authentication
  // step. salt binds both public keys so the derived keys are unique to this
  // exact exchange.
  const ikm = concat(shared, pairingSecret);
  const salt = concat(clientPub, serverPub);
  const master = hkdf(sha256, ikm, salt, HKDF_INFO, 2 * KEY_LEN);
  return { c2s: master.slice(0, KEY_LEN), s2c: master.slice(KEY_LEN, 2 * KEY_LEN) };
}

/** The phone's side of the handshake, given its ephemeral key and the server's public key. */
export function clientSession(
  self: Ephemeral,
  serverPub: Uint8Array,
  pairingSecret: Uint8Array,
): Session {
  const shared = x25519.getSharedSecret(self.priv, serverPub);
  const { c2s, s2c } = deriveMaster(shared, pairingSecret, self.pub, serverPub);
  return { send: { key: c2s, next: 0n }, recv: { key: s2c, next: 0n } };
}

/** The server's side of the handshake, given its ephemeral key and the phone's public key. */
export function serverSession(
  self: Ephemeral,
  clientPub: Uint8Array,
  pairingSecret: Uint8Array,
): Session {
  const shared = x25519.getSharedSecret(self.priv, clientPub);
  const { c2s, s2c } = deriveMaster(shared, pairingSecret, clientPub, self.pub);
  return { send: { key: s2c, next: 0n }, recv: { key: c2s, next: 0n } };
}

/**
 * Seals a message for transmission. Wire form is `counter(8) ‖ ciphertext+tag`.
 * The counter is the nonce and advances every call, so a nonce is never reused
 * on one key.
 */
export function seal(session: Session, plaintext: Uint8Array): Uint8Array {
  const counter = session.send.next;
  session.send.next = counter + 1n;
  const nonce = nonceFor(counter);
  const ct = chacha20poly1305(session.send.key, nonce).encrypt(plaintext);
  return concat(counterBytes(counter), ct);
}

/**
 * Opens a received message, throwing on a bad tag (tamper) or a replayed/old
 * counter. On success the receive counter advances past the accepted message,
 * so re-delivering the same frame is refused.
 */
export function open(session: Session, wire: Uint8Array): Uint8Array {
  if (wire.length < 8 + 16) throw new Error("e2e: message too short");
  const counter = readCounter(wire);
  if (counter < session.recv.next) throw new Error("e2e: replayed or out-of-order message");
  const nonce = nonceFor(counter);
  const plaintext = chacha20poly1305(session.recv.key, nonce).decrypt(wire.slice(8));
  session.recv.next = counter + 1n;
  return plaintext;
}

/* -------------------------------------------------------------------------- */

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// 12-byte ChaCha20-Poly1305 nonce: 4 zero bytes then the 8-byte big-endian
// counter. The high 4 bytes stay zero; a session that sent 2^64 messages has
// bigger problems.
function nonceFor(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setBigUint64(4, counter, false);
  return nonce;
}

function counterBytes(counter: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, counter, false);
  return out;
}

function readCounter(wire: Uint8Array): bigint {
  return new DataView(wire.buffer, wire.byteOffset, 8).getBigUint64(0, false);
}
