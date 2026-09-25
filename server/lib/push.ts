/**
 * Web Push notifications.
 *
 * The point of the whole project: a phone that taps you on the shoulder when an
 * agent is waiting, rather than a dashboard you have to remember to open.
 *
 * Fires on the transition *into* `blocked`. Subscriptions live in SQLite so they
 * survive restarts, and endpoints the push service rejects as gone are dropped —
 * a stale subscription otherwise fails on every notification forever.
 *
 * iOS only permits Web Push for a PWA installed to the home screen, and only
 * over real HTTPS, which is what `tailscale serve` provides.
 *
 * The native app cannot use Web Push at all — there is no service worker — so it
 * registers an Expo push token instead and the same notification goes out over
 * both channels. The two are independent: Web Push needs VAPID keys and Expo
 * push needs none, so either can be configured without the other.
 */
import { serverIdentity } from "./identity";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import webpush, { type PushSubscription } from "web-push";
import type { Config } from "./config";
import { paneTitle, type SessionStore, type StatusChange } from "./state";

/** How long a repeat notification for the same pane is held back. */
const DEBOUNCE_MS = 5_000;

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/**
 * Expo refuses a whole request of more than 100 messages, so past 100 tokens
 * every notification failed for every phone, including the ones that worked.
 */
const EXPO_BATCH = 100;

/** Real endpoints are a few hundred characters, and keys under a hundred. */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

/**
 * Both push services refuse a payload over 4 KB, and a workspace label has no
 * length limit: a 1,900-character one made every notification from its
 * workspace fail, silently (pre-release bug hunt). These leave room for JSON
 * escaping and the platform's own fields; a phone shows far less anyway.
 */
const MAX_TITLE_BYTES = 160;
const MAX_BODY_BYTES = 512;

/**
 * An hour, and urgent. The defaults (four weeks, normal urgency) delivered a
 * "needs you" to a phone that came back online weeks after the question was
 * answered. A question still open after an hour is on the dashboard.
 */
const TTL_SECONDS = 3_600;

/**
 * A request that has not answered in 15 seconds has failed. Bun's default
 * held a hung Expo request for about five minutes.
 */
const TIMEOUT_MS = 15_000;

/**
 * Waits before retrying a send the push service refused for now (429, 5xx)
 * or never received (no connection). A send that timed out is not retried:
 * it may have been delivered, and a repeated notification is worse than one
 * that arrives late.
 */
const RETRY_DELAYS_MS = [2_000, 10_000];

/** Expo's own ticket error codes, which are safe to log: they name no one. */
const EXPO_ERRORS = new Set(["DeviceNotRegistered", "MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials"]);

export interface PushPayload {
  title: string;
  body: string;
  paneId: string;
  /**
   * Which conversation in the pane sent this (`DashboardPane.instanceId`), so
   * a tap after herdr has given the pane id to another program says the
   * conversation ended instead of opening the new one. Additive: an app that
   * does not read it routes by pane id as before.
   */
  instanceId?: string;
  serverId?: string;
}

/** Where delivery outcomes go: `Observability.event`, which keeps only allowlisted fields. */
export type PushLog = (event: "push.sent" | "push.failed", fields: { channel: "expo" | "web"; count: number; status?: number; reason?: string }) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Printable text of at most `maxBytes` of UTF-8, cut between graphemes so an
 * emoji or a combining mark is never split. Control characters become spaces:
 * they mean nothing in a notification and JSON escapes each into six bytes.
 */
export function fitText(text: string, maxBytes: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const encoder = new TextEncoder();
  if (encoder.encode(clean).length <= maxBytes) return clean;
  const budget = maxBytes - encoder.encode("…").length;
  let out = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(clean)) {
    const size = encoder.encode(segment).length;
    if (used + size > budget) break;
    out += segment;
    used += size;
  }
  return `${out}…`;
}

export class PushService {
  readonly #db: Database;
  readonly #serverId: string;
  readonly #enabled: boolean;
  readonly #lastNotifiedAt = new Map<string, number>();
  readonly #trailing = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Every failure used to collapse into a quiet 0 — a push service answering
   * 500, a MessageTooBig ticket, a hung request — so nothing in the log or the
   * diagnostics said notifications had stopped (pre-release bug hunt). Only
   * the channel, a count, an HTTP status and a fixed reason are logged; never
   * a token, an endpoint or a payload.
   */
  readonly #log: PushLog;

  constructor(
    db: Database,
    private readonly config: Config,
    log: PushLog = () => {},
  ) {
    this.#log = log;
    this.#db = db;
    this.#serverId = serverIdentity(db).serverId;
    // Unowned registrations cannot be revoked safely. Require a fresh opt-in.
    db.exec("DROP TABLE IF EXISTS push_subscription; DROP TABLE IF EXISTS expo_push_token");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS device_push_subscription (
        endpoint TEXT PRIMARY KEY,
        owner    TEXT NOT NULL,
        p256dh   TEXT NOT NULL,
        auth     TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS device_expo_push_token (
        token    TEXT PRIMARY KEY,
        owner    TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    // A passcode session's registrations end with the session, as they do on
    // its logout and on a device's revocation. Its expiry lived only inside the
    // cookie, so a session that simply ran out kept its phone or browser
    // notified for good, and nothing could remove the rows: logout after
    // expiry has no cookie to name them by (pre-release bug hunt). Devices
    // store NULL; revocation ends theirs. Rows from before this column belong
    // to sessions that end within one session lifetime from now.
    for (const table of ["device_push_subscription", "device_expo_push_token"]) {
      const columns = this.#db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (columns.some((c) => c.name === "expires_at")) continue;
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN expires_at INTEGER`);
      this.#db.run(`UPDATE ${table} SET expires_at = ? WHERE owner LIKE 'session:%'`, [Date.now() + config.sessionTtlMs]);
    }

    this.#enabled = config.vapid !== null;
    if (config.vapid) {
      webpush.setVapidDetails(
        config.vapid.subject,
        config.vapid.publicKey,
        config.vapid.privateKey,
      );
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** The VAPID public key the browser needs in order to subscribe. */
  get publicKey(): string | null {
    return this.config.vapid?.publicKey ?? null;
  }

  /**
   * Bounded as well as shaped: every stored registration is sent on every
   * notification, so a megabyte-long one costs that on each send.
   */
  isSubscription(value: unknown): value is PushSubscription {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as PushSubscription;
    return (
      typeof candidate.endpoint === "string" &&
      candidate.endpoint.startsWith("https://") &&
      candidate.endpoint.length <= MAX_ENDPOINT_LENGTH &&
      typeof candidate.keys?.p256dh === "string" &&
      candidate.keys.p256dh.length <= MAX_KEY_LENGTH &&
      typeof candidate.keys?.auth === "string" &&
      candidate.keys.auth.length <= MAX_KEY_LENGTH
    );
  }

  /**
   * One registration per owner. A browser holds one subscription for this
   * app, and a phone one Expo token; a new one replaces the old rather than
   * joining it, so no owner can grow the table — a registration that can no
   * longer deliver otherwise fails on every notification until the push
   * service happens to report it gone.
   *
   * `expiresAt` is a passcode session's expiry, and null for a paired device.
   */
  subscribe(subscription: PushSubscription, owner = "local", expiresAt: number | null = null): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM device_push_subscription WHERE owner = ? AND endpoint != ?", [owner, subscription.endpoint]);
      this.#db.run(
        `INSERT INTO device_push_subscription (endpoint, p256dh, auth, added_at, owner, expires_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, owner = excluded.owner, expires_at = excluded.expires_at`,
        [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now(), owner, expiresAt],
      );
    })();
  }

  unsubscribe(endpoint: string, owner?: string): void {
    this.#db.run("DELETE FROM device_push_subscription WHERE endpoint = ?" + (owner ? " AND owner = ?" : ""), owner ? [endpoint, owner] : [endpoint]);
  }

  count(): number {
    this.#forgetExpired();
    return (
      (this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_push_subscription").get()?.n ??
        0) +
      (this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM device_expo_push_token").get()?.n ?? 0)
    );
  }

  /**
   * Expo's push tokens have a fixed shape, and this is the whole validation.
   * Anything else would be rejected by Expo anyway, but a token that cannot work
   * should not be stored and retried on every notification.
   */
  isExpoToken(value: unknown): value is string {
    // Real tokens are about forty characters; the bound is generous, not tight.
    return typeof value === "string" && /^Expo(nent)?PushToken\[[^\]]{1,200}\]$/.test(value);
  }

  /** One per owner, for the reason `subscribe` gives. */
  subscribeExpo(token: string, owner = "local", expiresAt: number | null = null): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM device_expo_push_token WHERE owner = ? AND token != ?", [owner, token]);
      this.#db.run(
        `INSERT INTO device_expo_push_token (token, added_at, owner, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
        [token, Date.now(), owner, expiresAt],
      );
    })();
  }

  unsubscribeExpo(token: string, owner?: string): void {
    this.#db.run("DELETE FROM device_expo_push_token WHERE token = ?" + (owner ? " AND owner = ?" : ""), owner ? [token, owner] : [token]);
  }

  unsubscribeOwner(owner: string): void {
    this.#db.run("DELETE FROM device_push_subscription WHERE owner = ?", [owner]);
    this.#db.run("DELETE FROM device_expo_push_token WHERE owner = ?", [owner]);
  }

  /** Registrations whose passcode session has ended; see the constructor. */
  #forgetExpired(now = Date.now()): void {
    this.#db.run("DELETE FROM device_push_subscription WHERE expires_at <= ?", [now]);
    this.#db.run("DELETE FROM device_expo_push_token WHERE expires_at <= ?", [now]);
  }

  /**
   * Notifies when an agent starts waiting on a human.
   *
   * Only `blocked` notifies. `done` was tempting, but a finished turn is not
   * urgent and firing on both would train you to ignore the notifications.
   */
  async notifyStatusChange(change: StatusChange, store: SessionStore): Promise<void> {
    if (change.to !== "blocked") return;

    // The first snapshot reports every pane's status. Waking a phone for
    // agents that were already blocked before this process started is noise,
    // not news. A pane first seen after that, already blocked, is news.
    if (change.initial) return;

    // A second question inside the window used to be dropped outright: answer
    // one, block again a second later, and nothing ever arrived (pre-release
    // bug hunt). It is checked again when the window ends instead, and still
    // notified if the pane is still waiting then. One timer per pane: however
    // many changes land in the window, the answer is one notification or none.
    const wait = (this.#lastNotifiedAt.get(change.paneId) ?? -Infinity) + DEBOUNCE_MS - Date.now();
    if (wait > 0) {
      if (this.#trailing.has(change.paneId)) return;
      const timer = setTimeout(() => {
        this.#trailing.delete(change.paneId);
        if (store.pane(change.paneId)?.agent_status !== "blocked") return;
        void this.notifyStatusChange(change, store);
      }, wait);
      timer.unref?.();
      this.#trailing.set(change.paneId, timer);
      return;
    }
    this.#lastNotifiedAt.set(change.paneId, Date.now());

    const pane = store.pane(change.paneId);
    const workspaceLabel = store.workspace(change.workspaceId)?.label ?? change.workspaceId;
    const suffix = " needs you";

    const instanceId = store.instance(change.paneId);
    await this.send({
      title: fitText(workspaceLabel, MAX_TITLE_BYTES - suffix.length) + suffix,
      // The dashboard's title for the pane, so the notification names what the
      // list does: a labelled pane with no terminal title read as its raw id.
      body: fitText((pane && paneTitle(pane)) ?? change.paneId, MAX_BODY_BYTES),
      paneId: change.paneId,
      ...(instanceId ? { instanceId } : {}),
    });
  }

  async sendTest(): Promise<number> {
    return this.send({
      title: "Shahi",
      body: "Notifications are working.",
      paneId: "",
    });
  }

  /** Delivers over both channels, returning how many deliveries succeeded. */
  async send(payload: PushPayload): Promise<number> {
    this.#forgetExpired();
    payload = { ...payload, serverId: this.#serverId };
    const [web, native] = await Promise.all([this.#sendWebPush(payload), this.#sendExpo(payload)]);
    return web + native;
  }

  /**
   * Hands the notification to Expo's push service, which passes it to FCM or
   * APNs.
   *
   * Tokens Expo reports as `DeviceNotRegistered` are dropped: the app has been
   * uninstalled or the token rotated, and keeping it means failing forever.
   */
  async #sendExpo(payload: PushPayload): Promise<number> {
    const tokens = this.#db
      .query<{ token: string }, []>("SELECT token FROM device_expo_push_token")
      .all()
      .map((row) => row.token);
    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += EXPO_BATCH) batches.push(tokens.slice(i, i + EXPO_BATCH));
    const delivered = await Promise.all(batches.map((batch) => this.#sendExpoBatch(batch, payload)));
    return delivered.reduce((sum, n) => sum + n, 0);
  }

  async #sendExpoBatch(tokens: string[], payload: PushPayload): Promise<number> {
    const messages = tokens.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      data: { paneId: payload.paneId, instanceId: payload.instanceId, serverId: payload.serverId },
      sound: "default",
      ttl: TTL_SECONDS,
      priority: "high",
      // Android needs a channel to make any sound at all; the app creates it.
      channelId: "blocked",
    }));

    const failed = (fields: { status?: number; reason: string }) => {
      this.#log("push.failed", { channel: "expo", count: tokens.length, ...fields });
      return 0;
    };
    for (let attempt = 0; ; attempt++) {
      const retry = RETRY_DELAYS_MS[attempt];
      let res: Response;
      try {
        res = await fetch(EXPO_PUSH_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") return failed({ reason: "push timeout" });
        if (retry === undefined) return failed({ reason: "push unreachable" });
        await sleep(retry);
        continue;
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && retry !== undefined) {
          await sleep(retry);
          continue;
        }
        return failed({ status: res.status, reason: "push refused" });
      }
      const body = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null;
      if (!Array.isArray(body?.data)) return failed({ status: res.status, reason: "push malformed response" });

      let delivered = 0;
      const errors = new Map<string, number>();
      body.data.forEach((ticket, i) => {
        if (ticket.status === "ok") return void delivered++;
        const error = ticket.details?.error ?? "";
        const reason = EXPO_ERRORS.has(error) ? error : "other";
        errors.set(reason, (errors.get(reason) ?? 0) + 1);
        if (error === "DeviceNotRegistered") this.unsubscribeExpo(tokens[i]!);
      });
      if (delivered) this.#log("push.sent", { channel: "expo", count: delivered });
      for (const [reason, count] of errors) this.#log("push.failed", { channel: "expo", count, reason });
      return delivered;
    }
  }

  async #sendWebPush(payload: PushPayload): Promise<number> {
    if (!this.#enabled) return 0;

    const rows = this.#db
      .query<{ endpoint: string; p256dh: string; auth: string }, []>(
        "SELECT endpoint, p256dh, auth FROM device_push_subscription",
      )
      .all();

    // Exactly what the service worker reads, and nothing it does not. An
    // undefined instanceId (an older herdr, a pane with no occupant yet) is
    // left out by JSON itself.
    const body = JSON.stringify({ title: payload.title, body: payload.body, paneId: payload.paneId, instanceId: payload.instanceId, serverId: payload.serverId });
    const options = {
      TTL: TTL_SECONDS,
      urgency: "high" as const,
      // A newer notification for the same pane replaces one still queued for
      // an offline browser, rather than both arriving when it reconnects.
      // Hashed: a topic is at most 32 URL-safe characters, and is readable by
      // the push service.
      topic: createHash("sha256").update(`${payload.serverId}:${payload.paneId}`).digest("base64url").slice(0, 32),
      timeout: TIMEOUT_MS,
    };

    const results = await Promise.all(
      rows.map(async (row) => {
        const subscription: PushSubscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        for (let attempt = 0; ; attempt++) {
          const retry = RETRY_DELAYS_MS[attempt];
          try {
            await webpush.sendNotification(subscription, body, options);
            return { ok: true } as const;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            // 404/410 mean the browser dropped this subscription for good; keeping
            // it would mean failing on every future notification.
            if (status === 404 || status === 410) {
              this.unsubscribe(row.endpoint);
              return { ok: false, status, reason: "subscription gone" } as const;
            }
            // web-push's own words for its `timeout` firing.
            if (status === undefined && (err as Error)?.message === "Socket timeout") return { ok: false, reason: "push timeout" } as const;
            const transient = status === undefined || status === 429 || status >= 500;
            if (transient && retry !== undefined) {
              await sleep(retry);
              continue;
            }
            return { ok: false, status, reason: status === undefined ? "push unreachable" : "push refused" } as const;
          }
        }
      }),
    );

    const delivered = results.filter((r) => r.ok).length;
    if (delivered) this.#log("push.sent", { channel: "web", count: delivered });
    for (const r of results) if (!r.ok) this.#log("push.failed", { channel: "web", count: 1, reason: r.reason, ...(r.status ? { status: r.status } : {}) });
    return delivered;
  }
}
