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
import webpush, { type PushSubscription } from "web-push";
import type { Config } from "./config";
import type { SessionStore, StatusChange } from "./state";

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
  workspaceLabel: string;
  serverId?: string;
}

export class PushService {
  readonly #db: Database;
  readonly #serverId: string;
  readonly #enabled: boolean;
  readonly #lastNotifiedAt = new Map<string, number>();
  readonly #trailing = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    db: Database,
    private readonly config: Config,
  ) {
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
    const title = pane?.terminal_title_stripped ?? pane?.terminal_title ?? change.paneId;

    const instanceId = store.instance(change.paneId);
    await this.send({
      title: `${workspaceLabel} needs you`,
      body: title,
      paneId: change.paneId,
      ...(instanceId ? { instanceId } : {}),
      workspaceLabel,
    });
  }

  async sendTest(): Promise<number> {
    return this.send({
      title: "Shahi",
      body: "Notifications are working.",
      paneId: "",
      workspaceLabel: "",
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
      data: { paneId: payload.paneId, instanceId: payload.instanceId, workspaceLabel: payload.workspaceLabel, serverId: payload.serverId },
      sound: "default",
      // Android needs a channel to make any sound at all; the app creates it.
      channelId: "blocked",
    }));

    try {
      const res = await fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(messages),
      });
      const body = (await res.json()) as {
        data?: { status: string; details?: { error?: string } }[];
      };
      let delivered = 0;
      body.data?.forEach((ticket, i) => {
        if (ticket.status === "ok") delivered++;
        else if (ticket.details?.error === "DeviceNotRegistered") {
          this.unsubscribeExpo(tokens[i]!);
        }
      });
      return delivered;
    } catch {
      // A push service that is unreachable is not worth crashing a poll over.
      return 0;
    }
  }

  async #sendWebPush(payload: PushPayload): Promise<number> {
    if (!this.#enabled) return 0;

    const rows = this.#db
      .query<{ endpoint: string; p256dh: string; auth: string }, []>(
        "SELECT endpoint, p256dh, auth FROM device_push_subscription",
      )
      .all();

    const results = await Promise.all(
      rows.map(async (row) => {
        const subscription: PushSubscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        try {
          await webpush.sendNotification(subscription, JSON.stringify(payload));
          return true;
        } catch (err) {
          // 404/410 mean the browser dropped this subscription for good; keeping
          // it would mean failing on every future notification.
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(row.endpoint);
          return false;
        }
      }),
    );

    return results.filter(Boolean).length;
  }
}
