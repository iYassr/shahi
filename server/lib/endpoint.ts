/**
 * Is this bind address a loopback one?
 *
 * All that is left of a module that used to guess what address a phone should
 * be given — the Tailscale name, then the bind address, then a refusal. Nothing
 * asks that any more: a phone reaches the box through the relay or through an
 * SSH tunnel to this very loopback bind, and neither needs an address printed
 * on a code.
 *
 * `http.ts` still asks, for one thing: whether a request arrived locally, which
 * is what decides if `/api/meta` may name the relay.
 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
