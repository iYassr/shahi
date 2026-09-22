/**
 * HTTP Strict Transport Security for the relay's own hostname. Every response
 * the relay serves over HTTPS carries it, the WebSocket upgrade included, so a
 * browser that has once reached the relay never tries it over plain HTTP. The
 * relay sent none before the pre-release review (2026-09-22, P02-X1). A year,
 * and the relay hostname's subdomains with it.
 *
 * Never over plain HTTP: a host must not send it there (RFC 6797 §7.2), and
 * `wrangler dev` and the tests speak plain HTTP to loopback.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

/** The HSTS header for a response to `request`, or none when it did not arrive over HTTPS. */
export function hstsHeaders(request: Request): Record<string, string> {
  return new URL(request.url).protocol === "https:" ? { "strict-transport-security": STRICT_TRANSPORT_SECURITY } : {};
}
