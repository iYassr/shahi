export interface Env {
  OPERATIONS: { fetch(request: Request): Promise<Response> };
  ACCESS_AUD?: string;
}
type Access = { aud: string; getIdentity(): Promise<{ email?: string } | undefined> };
export type Assets = Record<string, { body: string; type: string }>;
const headers = {
  "cache-control": "no-store, no-transform",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-robots-tag": "noindex, nofollow",
};
function reply(body: string, status: number, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { ...headers, "content-type": type } });
}

/** Cloudflare supplies this context after authentication, never from request headers.
 * Assets are bundled modules: the static-assets router does not forward ctx.access.
 */
export async function handle(request: Request, env: Env, access: Access | undefined, assets: Assets): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return reply("HTTPS required", 403);
  if (!env.ACCESS_AUD || !access || access.aud !== env.ACCESS_AUD) return reply("Sign in through Cloudflare Access to open the Shahi dashboard.", 403);
  try {
    if (!(await access.getIdentity())?.email) return reply("An administrator sign-in is required.", 403);
  } catch { return reply("Sign-in verification is unavailable. Please try again.", 503); }
  if (request.method !== "GET") return reply("Method not allowed", 405);
  if (url.pathname === "/api/dashboard") {
    const range = url.searchParams.get("window") ?? "1h";
    if (!["1h", "24h", "7d"].includes(range)) return reply("Invalid time window", 400);
    try {
      const response = await env.OPERATIONS.fetch(new Request(`https://operations/dashboard?window=${range}`, { signal: AbortSignal.timeout(20_000) }));
      if (!response.ok) return reply("Dashboard data unavailable", 502);
      return reply(JSON.stringify(await response.json()), 200, "application/json");
    } catch { return reply("Dashboard data unavailable", 502); }
  }
  const key = url.pathname === "/statistics" ? "/" : url.pathname;
  // Do not consult Object.prototype for attacker-controlled paths.
  const asset = Object.hasOwn(assets, key) ? assets[key] : undefined;
  return asset ? reply(asset.body, 200, asset.type) : reply("Not found", 404);
}
