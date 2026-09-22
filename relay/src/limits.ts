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

/**
 * The least a phone frame costs against the phone's byte bucket. Charging
 * bytes alone made a 1-byte frame cost one token, so 64 KiB/s allowed about
 * 65,000 frames a second, and each one woke the Durable Object and counted
 * toward its usage (pre-release review 2026-09-22, F79). With this floor the
 * same budget allows 256 frames a second and a burst of 4,096.
 *
 * Real phones stay far inside it. Their small frames are requests of a couple
 * of hundred bytes, a few a second, and delivery acknowledgements of about 50
 * bytes sealed, one per 64 KiB received. The phone paces its sends against
 * its own copy of the bucket, counting their real size at 90% of the relay's
 * rate, so the floor's surcharge spends some of that 10% margin. It takes all
 * of it only at a sustained 2 MiB/s download during an upload at the limit,
 * and the 1 MiB burst covers a long stretch of even that. A larger floor
 * would start to cut real uploads short; a smaller one lets more frames
 * through. The lifecycle test for a phone's own small frames holds the line.
 */
export const PHONE_FRAME_MIN_BYTES = 256;

/**
 * What the front door's per-source connect limiter counts a source by: an
 * IPv4 address as it is, an IPv6 address by its /64.
 *
 * `cf-connecting-ip` is a full /128 for an IPv6 client, and the limiter keys
 * on exactly the string it is given. One host is routinely given a whole /64
 * (a cloud VM, a home line), and binding each connection to a fresh address
 * in it gave every connection a bucket of its own, so `CONNECT_LIMIT` never
 * tripped (pre-release review 2026-09-22, F80). A /64 is one host or one
 * subscriber's network by convention, and it is the unit Cloudflare's own
 * rate limiting counts IPv6 by, so grouping by it merges no strangers. A
 * source with a larger delegation still has one bucket per /64; the zone's
 * rate-limiting rule is the control for that.
 *
 * Anything that does not parse as plain IPv6 is keyed as given, including an
 * IPv4 address in IPv6 dress: that is one address, and keying it whole can
 * only ever separate sources, never merge them.
 */
export function connectLimitKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return ip;
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
