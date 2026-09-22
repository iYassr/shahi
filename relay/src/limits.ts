/**
 * Limits the relay enforces on its own, beside the protocol's `RELAY_LIMITS`
 * in `shared/`. Nothing on the other side of a socket needs these numbers to
 * speak the protocol, so they live with the Worker. Kept apart from `box.ts`
 * so the tests can read them without loading the Workers runtime.
 */

/**
 * Box sockets for one serverId that may wait on their challenge at once. It
 * bounds the per-object work a stranger can cause, since every lookup walks
 * these sockets.
 */
export const MAX_PENDING_BOXES = 8;

/**
 * How long a pending box socket is protected from eviction before its `auth`.
 *
 * When every pending slot is full, a newcomer evicts the socket that has
 * waited longest, provided that socket has had this long. Before this, the
 * relay refused the newcomer instead. Anyone who knew a serverId could then
 * hold all eight slots with silent sockets, reopened as the ten-second auth
 * deadline closed each one, and the real computer's reconnect was refused
 * with 4429 on every attempt (pre-release review 2026-09-22, F28/F33).
 *
 * The grace covers a real box's answer, which takes one round trip: the box
 * signs the challenge as soon as it arrives. Without the grace, an attacker
 * who saw its own squatter evicted could open eight more sockets and evict
 * the real box before its answer arrived. With it, holding every slot means
 * keeping eight sockets younger than one second at all times. That is eight
 * connections a second, sustained, which one IPv4 address or IPv6 /64 cannot
 * do under `CONNECT_LIMIT` (thirty per ten seconds).
 */
export const EVICTION_GRACE_MS = 1_000;
