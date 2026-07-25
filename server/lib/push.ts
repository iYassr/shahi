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
 */
import { Database } from "bun:sqlite";
import webpush, { type PushSubscription } from "web-push";
import type { Config } from "./config";
import type { SessionStore, StatusChange } from "./state";

/** How long to suppress repeat notifications for the same pane. */
const DEBOUNCE_MS = 5_000;

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
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscription (
        endpoint TEXT PRIMARY KEY,
        p256dh   TEXT NOT NULL,
        auth     TEXT NOT NULL,
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

  subscribe(subscription: PushSubscription): void {
    this.#db.run(
      `INSERT INTO push_subscription (endpoint, p256dh, auth, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()],
    );
  }

  unsubscribe(endpoint: string): void {
    this.#db.run("DELETE FROM push_subscription WHERE endpoint = ?", [endpoint]);
  }

  count(): number {
    return this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM push_subscription").get()?.n ?? 0;
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
      title: "HerdrUI",
      body: "Notifications are working.",
      paneId: "",
      workspaceLabel: "",
    });
  }

  /** Delivers to every subscription, returning how many succeeded. */
  async send(payload: PushPayload): Promise<number> {
    if (!this.#enabled) return 0;

    const rows = this.#db
      .query<{ endpoint: string; p256dh: string; auth: string }, []>(
        "SELECT endpoint, p256dh, auth FROM push_subscription",
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
