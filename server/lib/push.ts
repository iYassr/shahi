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
import { Database } from "bun:sqlite";
import webpush, { type PushSubscription } from "web-push";
import type { Config } from "./config";
import type { SessionStore, StatusChange } from "./state";

/** How long to suppress repeat notifications for the same pane. */
const DEBOUNCE_MS = 5_000;

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

export interface PushPayload {
  title: string;
  body: string;
  paneId: string;
  workspaceLabel: string;
}

export class PushService {
  readonly #db: Database;
  readonly #enabled: boolean;
  readonly #lastNotifiedAt = new Map<string, number>();

  constructor(
    db: Database,
    private readonly config: Config,
  ) {
    this.#db = db;
    // Unowned registrations cannot be revoked safely. Require a fresh opt-in.
    db.exec("DROP TABLE IF EXISTS push_subscription; DROP TABLE IF EXISTS expo_push_token");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS device_push_subscription (
        endpoint TEXT PRIMARY KEY,
        owner    TEXT NOT NULL,
        p256dh   TEXT NOT NULL,
        auth     TEXT NOT NULL,
        added_at INTEGER NOT NULL
      )
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS device_expo_push_token (
        token    TEXT PRIMARY KEY,
        owner    TEXT NOT NULL,
        added_at INTEGER NOT NULL
      )
    `);

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

  isSubscription(value: unknown): value is PushSubscription {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as PushSubscription;
    return (
      typeof candidate.endpoint === "string" &&
      candidate.endpoint.startsWith("https://") &&
      typeof candidate.keys?.p256dh === "string" &&
      typeof candidate.keys?.auth === "string"
    );
  }

  subscribe(subscription: PushSubscription, owner = "local"): void {
    this.#db.run(
      `INSERT INTO device_push_subscription (endpoint, p256dh, auth, added_at, owner) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, owner = excluded.owner`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now(), owner],
    );
  }

  unsubscribe(endpoint: string, owner?: string): void {
    this.#db.run("DELETE FROM device_push_subscription WHERE endpoint = ?" + (owner ? " AND owner = ?" : ""), owner ? [endpoint, owner] : [endpoint]);
  }

  count(): number {
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
    return typeof value === "string" && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value);
  }

  subscribeExpo(token: string, owner = "local"): void {
    this.#db.run(
      `INSERT INTO device_expo_push_token (token, added_at, owner) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET owner = excluded.owner`,
      [token, Date.now(), owner],
    );
  }

  unsubscribeExpo(token: string, owner?: string): void {
    this.#db.run("DELETE FROM device_expo_push_token WHERE token = ?" + (owner ? " AND owner = ?" : ""), owner ? [token, owner] : [token]);
  }

  unsubscribeOwner(owner: string): void {
    this.#db.run("DELETE FROM device_push_subscription WHERE owner = ?", [owner]);
    this.#db.run("DELETE FROM device_expo_push_token WHERE owner = ?", [owner]);
  }

  /**
   * Notifies when an agent starts waiting on a human.
   *
   * Only `blocked` notifies. `done` was tempting, but a finished turn is not
   * urgent and firing on both would train you to ignore the notifications.
   */
  async notifyStatusChange(change: StatusChange, store: SessionStore): Promise<void> {
    if (change.to !== "blocked") return;

    // The initial baseline reports every pane's status with `from: undefined`.
    // Waking a phone for agents that were already blocked before this process
    // started is noise, not news.
    if (change.from === undefined) return;

    const now = Date.now();
    const last = this.#lastNotifiedAt.get(change.paneId) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.#lastNotifiedAt.set(change.paneId, now);

    const pane = store.pane(change.paneId);
    const workspaceLabel = store.workspace(change.workspaceId)?.label ?? change.workspaceId;
    const title = pane?.terminal_title_stripped ?? pane?.terminal_title ?? change.paneId;

    await this.send({
      title: `${workspaceLabel} needs you`,
      body: title,
      paneId: change.paneId,
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
    if (tokens.length === 0) return 0;

    const messages = tokens.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      data: { paneId: payload.paneId, workspaceLabel: payload.workspaceLabel },
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
