import { Container } from "@cloudflare/containers";

interface Env {
  DEMO: DurableObjectNamespace<ReviewContainer>;
  STATE: R2Bucket;
  LOGIN_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> };
  DEMO_ORIGIN: string;
  RELAY_URL: string;
  REVIEW_EXPIRES_AT: string;
  REVIEW_PASSWORD: string;
  INTERNAL_TOKEN: string;
  SESSION_SECRET: string;
  PASSCODE_HASH_B64: string;
}

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function reply(body: string, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...headers, ...extra } });
}
async function same(a: string, b: string): Promise<boolean> {
  const digest = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let delta = 0;
  for (let i = 0; i < u.length; i++) delta |= u[i]! ^ v[i]!;
  return delta === 0;
}
const loginPage = () => reply(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shahi review sign-in</title><style>body{font:17px/1.6 system-ui;background:#151513;color:#f3eee5;max-width:480px;margin:70px auto;padding:24px}label{display:block;margin-top:20px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;border-radius:10px}button{margin-top:24px;background:#e8b496;color:#201a15;border:0}a{color:#e8b496}</style><h1>Shahi review</h1><p>Sign in to the isolated demo computer using the review credentials.</p><form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Sign in</button></form><p><a href="https://getshahi.dev/privacy">Privacy policy</a> · <a href="mailto:support@getshahi.dev">Get help</a></p></html>`, 200, { "content-type": "text/html; charset=utf-8" });
async function signature(value: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`shahi-review:${value}`)));
  return Array.from(bytes).map(v => v.toString(16).padStart(2,"0")).join("");
}
async function signedIn(request: Request, env: Env) {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)review_session=(\d+)\.([a-f0-9]{64})(?:;|$)/);
  if (!cookie || Number(cookie[1]) < Date.now() || Number(cookie[1]) > Date.now() + 7 * 86400000) return false;
  return same(cookie[2]!, await signature(cookie[1]!, env.SESSION_SECRET));
}
const configured = (env: Env) => env.INTERNAL_TOKEN?.length >= 32 && env.REVIEW_PASSWORD?.length >= 32 && env.SESSION_SECRET?.length >= 32 && !!env.PASSCODE_HASH_B64;
const active = (env: Env) => Date.now() < Date.parse(env.REVIEW_EXPIRES_AT);

export class ReviewContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";
  envVars = {
    DEMO_ORIGIN: this.env.DEMO_ORIGIN,
    RELAY_URL: this.env.RELAY_URL,
    INTERNAL_TOKEN: this.env.INTERNAL_TOKEN,
    SESSION_SECRET: this.env.SESSION_SECRET,
    PASSCODE_HASH_B64: this.env.PASSCODE_HASH_B64,
  };
  async control(path: string, method = "GET") {
    if (!active(this.env)) return reply("Review environment expired", 410);
    await this.startAndWaitForPorts({ cancellationOptions: { portReadyTimeoutMS: 120_000 } });
    return this.containerFetch(`http://container${path}`, {
      method, headers: { authorization: `Bearer ${this.env.INTERNAL_TOKEN}` },
    });
  }
  async expire() {
    try { await this.stop(); } finally { await this.env.STATE.delete("snapshot.tar.gz"); }
  }
  async restart() {
    const saved = await this.control("/checkpoint", "POST");
    if (!saved.ok) return reply("Checkpoint failed; restart cancelled", 503);
    await this.stop();
    return reply("Restart requested");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!configured(env)) return reply("Demo setup is in progress", 503);
    const url = new URL(request.url);
    if (url.origin !== env.DEMO_ORIGIN) return reply("Not found", 404);
    // The root controller alone can persist state. This credential never enters
    // the unprivileged shell/agent environment or the reviewer's browser.
    if (url.pathname === "/_state") {
      if (!await same(request.headers.get("authorization") ?? "", `Bearer ${env.INTERNAL_TOKEN}`)) return reply("Not found", 404);
      if (request.method === "GET") {
        const state = await env.STATE.get("snapshot.tar.gz");
        return state ? new Response(state.body, { headers }) : reply("No snapshot", 404);
      }
      if (request.method === "PUT") {
        if (!active(env)) return reply("Review environment expired", 410);
        const size = Number(request.headers.get("content-length"));
        if (!size || size > 32 * 1024 * 1024) return reply("Snapshot too large", 413);
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength !== size) return reply("Invalid snapshot", 400);
        await env.STATE.put("snapshot.tar.gz", bytes);
        return reply("Saved");
      }
      return reply("Method not allowed", 405);
    }
    if (!active(env)) return reply("This review environment has expired. Contact support@getshahi.dev.", 410);
    if (url.pathname === "/login" && request.method === "POST") {
      if (request.headers.get("origin") !== env.DEMO_ORIGIN) return reply("Invalid origin", 403);
      if (!Number(request.headers.get("content-length")) || Number(request.headers.get("content-length")) > 4096) return reply("Invalid sign-in request", 400);
      const allowed = await env.LOGIN_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
      if (!allowed.success) return reply("Please wait a minute before trying again.", 429);
      const form = await request.formData();
      if (form.get("username") !== "reviewer" || !await same(String(form.get("password") ?? ""), env.REVIEW_PASSWORD)) return reply("Incorrect review credentials. Go back and try again.", 401);
      const expiry = String(Date.now() + 7 * 86400000);
      return reply("Signed in", 303, { location: "/", "set-cookie": `review_session=${expiry}.${await signature(expiry, env.SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` });
    }
    if (!await same(request.headers.get("authorization") ?? "", `Basic ${btoa(`reviewer:${env.REVIEW_PASSWORD}`)}`) && !await signedIn(request, env)) {
      if (url.pathname === "/" && request.method === "GET") return loginPage();
      return reply("Sign in to the review page first.", 401);
    }
    if (!["GET", "POST"].includes(request.method)) return reply("Method not allowed", 405);
    if (request.method === "POST" && request.headers.get("origin") && request.headers.get("origin") !== env.DEMO_ORIGIN) return reply("Invalid origin", 403);
    if (url.pathname === "/_restart" && request.method === "POST") {
      // Separate operator credential: reviewer access cannot restart the host.
      if (!await same(request.headers.get("x-operator-token") ?? "", env.INTERNAL_TOKEN)) return reply("Not found", 404);
      return env.DEMO.getByName("apple-review").restart();
    }
    const path = url.pathname === "/" && request.method === "GET" ? "/" :
      url.pathname === "/pair" && request.method === "POST" ? "/pair" :
      url.pathname === "/health" && request.method === "GET" ? "/health" : null;
    if (!path) return reply("Not found", 404);
    try {
      const response = await env.DEMO.getByName("apple-review").control(path, request.method);
      const output = new Response(response.body, response);
      for (const [name, value] of Object.entries(headers)) output.headers.set(name, value);
      return output;
    } catch {
      return reply("The demo computer is starting. Please try again in a minute. Contact support@getshahi.dev if it does not recover.", 503);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (!configured(env)) return;
    if (active(env)) ctx.waitUntil(env.DEMO.getByName("apple-review").control("/health"));
    else ctx.waitUntil(env.DEMO.getByName("apple-review").expire());
  },
};
