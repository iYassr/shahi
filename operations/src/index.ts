import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { advance, notification, type Incident } from "./incidents";
import { probeTunnel } from "./probe";

interface Env {
  MONITOR: DurableObjectNamespace<Monitor>;
  ALERT_EMAIL: SendEmail;
  ALERT_TO: string;
  STATS_TOKEN: string;
}
interface Check { healthy: boolean; durationMs: number }
interface State { checkedAt: string; checks: Record<string, Check>; incidents: Record<string, Incident>; deliveryFailures: number }
const RELAY = "https://relay.getshahi.dev";
const SITE = "https://getshahi.dev";

async function sendAlert(env: Env, subject: string, text: string): Promise<void> {
  const raw = ["From: Shahi Alerts <alerts@getshahi.dev>", `To: ${env.ALERT_TO}`, `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@getshahi.dev>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n");
  // The existing Email Routing destination is verified; no marketing email service is needed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([env.ALERT_EMAIL.send(new EmailMessage("alerts@getshahi.dev", env.ALERT_TO, raw)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("email timeout")), 10_000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class Monitor extends DurableObject<Env> {
  #running: Promise<State> | null = null;
  run(): Promise<State> {
    if (this.#running) return this.#running;
    this.#running = this.check().finally(() => { this.#running = null; });
    return this.#running;
  }
  async status(): Promise<State | null> { return (await this.ctx.storage.get<State>("state")) ?? null; }
  private async check(): Promise<State> {
    const previous = await this.status();
    const checks: Record<string, Check> = {};
    const run = async (name: string, task: () => Promise<unknown>) => {
      const start = Date.now();
      try { await task(); checks[name] = { healthy: true, durationMs: Date.now() - start }; }
      catch { checks[name] = { healthy: false, durationMs: Date.now() - start }; }
    };
    const http = async (url: string, status = 200) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual", headers: { "cache-control": "no-cache" } });
      await res.body?.cancel();
      if (res.status !== status) throw new Error("unexpected status");
    };
    await Promise.all([
      run("website", () => http(SITE)), run("browser_app", () => http(`${SITE}/pwa/`)),
      run("signup_api", () => http(`${SITE}/api/ios-beta`, 405)),
      run("relay_http", () => http(`${RELAY}/health`)), run("relay_tunnel", () => probeTunnel(RELAY, this.env.STATS_TOKEN)),
      run("analytics", async () => {
        const res = await fetch(`${RELAY}/stats`, { headers: { authorization: `Bearer ${this.env.STATS_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error("stats unavailable");
        const body = await res.json() as { alerts?: Record<string, number>; site?: { status: number; n: number }[] };
        if (!body.alerts) throw new Error("missing metrics");
        const m = body.alerts;
        checks.signup_delivery_errors = { healthy: (body.site ?? []).filter((row) => Number(row.status) >= 500).reduce((n, row) => n + Number(row.n), 0) < 3, durationMs: 0 };
        const connections = m.connect ?? 0;
        checks.relay_errors = { healthy: (m.internal_error ?? 0) < 5, durationMs: 0 };
        checks.connection_rejections = { healthy: (m.rate_limited ?? 0) < 100 || (m.rate_limited ?? 0) / Math.max(1, connections + (m.rate_limited ?? 0)) < 0.2, durationMs: 0 };
        checks.authentication_failures = { healthy: (m.auth_failed ?? 0) < 50, durationMs: 0 };
        checks.reconnect_storm = { healthy: (m.box_gone ?? 0) < 100, durationMs: 0 };
      }),
    ]);
    checks.service_latency = { healthy: Object.values(checks).every((c) => !c.healthy || c.durationMs <= 3000), durationMs: 0 };
    const incidents = { ...previous?.incidents };
    let deliveryFailures = previous?.deliveryFailures ?? 0;
    for (const [name, result] of Object.entries(checks)) {
      const state = advance(incidents[name], result.healthy);
      incidents[name] = state;
      const action = notification(state, Date.now());
      if (!action) continue;
      try {
        await sendAlert(this.env, `[Shahi ${action === "firing" ? "INCIDENT" : "RECOVERED"}] ${name}`,
          `Shahi operational monitor: ${name} is ${action}.\nTime: ${new Date().toISOString()}\nThree failed checks trigger an incident; two healthy checks recover it.\nRepeated incidents are reminded hourly.\nInspect Workers Observability for shahi-relay and shahi-operations, and docs/operations.md in the Shahi repository.\nNo terminal content or user credentials are collected by this monitor.`);
        state.notified = action === "firing";
        state.lastSent = Date.now();
        console.log({ service: "shahi-operations", event: "alert_sent", check: name, state: action });
      } catch { deliveryFailures++; console.error({ service: "shahi-operations", event: "alert_delivery_failed", check: name }); }
    }
    const state: State = { checkedAt: new Date().toISOString(), checks, incidents, deliveryFailures };
    await this.ctx.storage.put("state", state);
    console.log({ service: "shahi-operations", event: "monitor_check", checks, deliveryFailures });
    return state;
  }
}

export default {
  async scheduled(_controller, env, ctx) { ctx.waitUntil(env.MONITOR.getByName("production").run()); },
  // This Worker has no public route, workers.dev or preview URL. Only the relay's
  // authenticated administrative service binding can call these handlers.
  async fetch(request, env) {
    const monitor = env.MONITOR.getByName("production");
    if (new URL(request.url).pathname === "/status" && request.method === "GET") return Response.json(await monitor.status());
    if (new URL(request.url).pathname === "/check" && request.method === "POST") return Response.json(await monitor.run());
    if (new URL(request.url).pathname === "/test-alert" && request.method === "POST") {
      await sendAlert(env, "Shahi operational alerts are enabled",
        "This is the setup test for Shahi's operational incident alerts. The monitor checks the public services and a synthetic relay round trip every minute. Incidents trigger after three failed checks and recover after two healthy checks. Repeated alerts are limited to once an hour. This test does not indicate a service outage.");
      return Response.json({ accepted: true });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
