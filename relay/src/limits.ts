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
 * How long a socket that has not yet identified itself is protected from
 * eviction: a pending box before its `auth`, a phone before its first frame.
 *
 * When every slot is full, a newcomer evicts the socket that has waited
 * longest, provided that socket has had this long. Before this, the relay
 * refused the newcomer instead. Anyone who knew a serverId could then hold
 * all eight pending-box slots with silent sockets, reopened as the ten-second
 * auth deadline closed each one, and the real computer's reconnect was
 * refused with 4429 on every attempt (pre-release review 2026-09-22,
 * F28/F33). Phone slots had the same shape, over the fifteen-second hello
 * deadline.
 *
 * The grace covers a real peer's first frame, which takes one round trip: the
 * box signs the challenge as soon as it arrives, and a phone sends its hello
 * the moment its socket opens. Without the grace, an attacker who saw its own
 * squatter evicted could open eight more sockets and evict the real peer
 * before its answer arrived. With it, holding every slot means
 * keeping eight sockets younger than one second at all times. That is eight
 * connections a second, sustained, which one IPv4 address or IPv6 /64 cannot
 * do under `CONNECT_LIMIT` (thirty per ten seconds).
 */
export const EVICTION_GRACE_MS = 1_000;
