import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";

const BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000, 330000];
const METHODS = new Set(["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"]);
const ROUTES = new Set(["meta", "diagnostics", "session", "dirs", "agents", "agents/start", "workspaces", "file", "uploads", "rpc", "pair", "pair/claim", "devices", "auth/status", "auth/login", "auth/logout", "push/key", "push/subscribe", "push/unsubscribe", "push/expo", "push/expo/unsubscribe", "push/test"]);
const ACTIONS = new Set(["screen", "log", "transcript", "prompt", "keys", "answer", "stop", "close", "resize", "image"]);
const EVENTS = new Set(["runtime.started", "runtime.stopped", "runtime.summary", "state.error", "poller.error", "subscriber.error", "relay.protocol_mismatch", "relay.auth_timeout", "relay.retry", "relay.connected", "relay.silent", "relay.link_refused", "relay.link_open", "relay.link_closed", "relay.request_rejected", "relay.response_oversized", "alert.firing", "alert.recovered"]);
const REASONS = new Set(["a request without a path", "device revoked", "backpressure", "frame too large", "send failed", "response failed", "authentication timeout", "a frame did not open", "a frame was not JSON", "a malformed message", "unknown device", "unknown pairing code", "a hello did not derive", "a malformed hello", "an oversized hello", "invalid acknowledgement", "session expired", "server stopping"]);

/** Fixed route labels. IDs, filenames, queries and unknown URLs never enter a log or metric key. */
export function routeLabel(path: string): string {
  if (path === "/ws") return "ws";
  if (!path.startsWith("/api/")) return "static";
  const route = path.slice(5);
  if (ROUTES.has(route)) return route;
  if (/^devices\/[^/]+$/.test(route)) return "devices/:id";
  if (/^workspaces\/[^/]+\/tabs$/.test(route)) return "workspaces/:id/tabs";
  const pane = /^panes\/[^/]+(?:\/([a-z]+))?$/.exec(route);
  if (pane) return `panes/:id/${ACTIONS.has(pane[1] ?? "") ? pane[1] : "other"}`;
  return "unknown";
}

interface RequestMetric { count: number; errors: number; rejected: number; durationMs: number; maxMs: number; buckets: number[] }
type Fields = Record<string, number | string | boolean>;

/** A private, bounded JSONL sink. Failure or disk exhaustion never fails a request. */
export function rotatingLog(path: string, maxBytes = 5 * 1024 * 1024): (row: object) => void {
  let bytes = existsSync(path) ? statSync(path).size : 0;
  return (row) => {
    const line = JSON.stringify(row) + "\n";
    try {
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        for (let n = 2; n >= 0; n--) {
          const source = n === 0 ? path : `${path}.${n}`;
          if (existsSync(source)) renameSync(source, `${path}.${n + 1}`);
        }
        bytes = 0;
      }
      appendFileSync(path, line, { mode: 0o600 });
      chmodSync(path, 0o600);
      bytes += Buffer.byteLength(line);
    } catch { /* Observability cannot take down the service it observes. */ }
  };
}

export class Observability {
  readonly startedAt = Date.now();
  readonly requests = new Map<string, RequestMetric>();
  readonly events = new Map<string, number>();
  readonly alerts = new Set<string>();
  inFlight = 0;
  droppedLogs = 0;
  #logWindow = 0;
  #logged = 0;
  #windowRequests = 0;
  #windowErrors = 0;
  #relayLostAt = 0;
  constructor(private readonly sink: (row: object) => void = () => {}) {}

  event = (event: string, fields: Fields = {}): void => {
    if (!EVENTS.has(event)) return;
    const key = this.events.has(event) || this.events.size < 128 ? event : "other.event";
    this.events.set(key, (this.events.get(key) ?? 0) + 1);
    this.write(event, fields);
  };

  private write(event: string, fields: Fields): void {
    const now = Date.now();
    if (now - this.#logWindow >= 60_000) { this.#logWindow = now; this.#logged = 0; }
    if (this.#logged++ >= 240) { this.droppedLogs++; return; }
    // A closed field vocabulary guards future callers against accidentally passing a request or error.
    const safe: Fields = {};
    for (const field of ["code", "retryMs", "links", "status", "durationMs", "inFlight", "rssBytes", "heapBytes", "lagMs", "count", "errors", "droppedLogs", "uptimeSeconds"]) {
      if (typeof fields[field] === "number" && Number.isFinite(fields[field])) safe[field] = fields[field];
    }
    if (typeof fields.connected === "boolean") safe.connected = fields.connected;
    if (fields.transport === "http" || fields.transport === "relay") safe.transport = fields.transport;
    if (typeof fields.method === "string") safe.method = METHODS.has(fields.method) ? fields.method : "OTHER";
    if (typeof fields.route === "string") safe.route = fields.route === "static" || fields.route === "ws" ? fields.route : routeLabel(`/api/${fields.route}`);
    if (typeof fields.reason === "string") safe.reason = REASONS.has(fields.reason) ? fields.reason : "other";
    if (typeof fields.alert === "string" && ["relay_offline", "high_error_rate", "high_memory", "event_loop_lag"].includes(fields.alert)) safe.alert = fields.alert;
    try { this.sink({ time: new Date(now).toISOString(), service: "shahi-sidecar", event, ...safe }); } catch {}
  }

  request(req: Request, transport: "http" | "relay", status: number, durationMs: number): void {
    const route = routeLabel(new URL(req.url).pathname);
    const method = METHODS.has(req.method) ? req.method : "OTHER";
    const label = `${transport} ${method} ${route}`;
    const key = this.requests.has(label) || this.requests.size < 128 ? label : "other";
    const metric = this.requests.get(key) ?? { count: 0, errors: 0, rejected: 0, durationMs: 0, maxMs: 0, buckets: BUCKETS.map(() => 0).concat(0) };
    metric.count++;
    metric.errors += Number(status >= 500);
    metric.rejected += Number([401, 403, 413, 429, 503].includes(status));
    metric.durationMs += durationMs;
    metric.maxMs = Math.max(metric.maxMs, durationMs);
    const index = BUCKETS.findIndex((b) => durationMs <= b);
    metric.buckets[index < 0 ? BUCKETS.length : index]!++;
    this.requests.set(key, metric);
    this.#windowRequests++;
    this.#windowErrors += Number(status >= 500);
    // Keep all aggregates, sample successful request logs and retain slow/failing ones subject to the cap.
    if (status >= 400 || durationMs >= 1000 || metric.count % 100 === 1) {
      this.write("http.request", { route, method, transport, status, durationMs: Math.round(durationMs), inFlight: this.inFlight });
    }
  }

  snapshot() {
    const { rss, heapUsed } = process.memoryUsage();
    return { since: new Date(this.startedAt).toISOString(), uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), inFlight: this.inFlight,
      rssBytes: rss, heapBytes: heapUsed, droppedLogs: this.droppedLogs, activeAlerts: [...this.alerts],
      events: Object.fromEntries(this.events), durationBucketUpperBoundsMs: [...BUCKETS, null], requests: Object.fromEntries(this.requests) };
  }

  tick(connected: boolean | null, lagMs = 0, now = Date.now()): void {
    const { rss, heapUsed } = process.memoryUsage();
    if (connected === false) this.#relayLostAt ||= now;
    else this.#relayLostAt = 0;
    const checks = { relay_offline: !!this.#relayLostAt && now - this.#relayLostAt >= 180_000,
      high_error_rate: this.#windowErrors >= 10 && this.#windowErrors / this.#windowRequests >= 0.05,
      high_memory: rss >= 768 * 1024 * 1024, event_loop_lag: lagMs >= 1000 };
    for (const [alert, active] of Object.entries(checks)) {
      if (active === this.alerts.has(alert)) continue;
      if (active) this.alerts.add(alert); else this.alerts.delete(alert);
      this.event(active ? "alert.firing" : "alert.recovered", { alert });
    }
    this.event("runtime.summary", { count: this.#windowRequests, errors: this.#windowErrors, inFlight: this.inFlight,
      rssBytes: rss, heapBytes: heapUsed, lagMs, droppedLogs: this.droppedLogs, ...(connected !== null ? { connected } : {}) });
    this.#windowRequests = this.#windowErrors = 0;
  }
}
