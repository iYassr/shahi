import { afterEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import webpush from "web-push";
import { Observability } from "./observability";
import { PushService, type PushLog } from "./push";
import type { Config } from "./config";
import type { HerdrClient } from "./herdr-client";
import type { AgentInfo, PaneInfo, SessionSnapshot } from "./herdr-schema";
import { SessionStore, type StatusChange } from "./state";

/** In memory, so a test run never touches the real subscription store. */
const service = (vapid: Config["vapid"] = null) =>
  new PushService(new Database(":memory:"), { vapid } as Config);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

/** Counts Expo requests, answering every message with an ok ticket. */
function expoRequests(): unknown[][] {
  const requests: unknown[][] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const messages = JSON.parse(String(init.body)) as unknown[];
    requests.push(messages);
    return Response.json({ data: messages.map(() => ({ status: "ok" })) });
  }) as unknown as typeof fetch;
  return requests;
}

/** Lets a fire-and-forget send reach `fetch` while timers are faked. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const paneInfo = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: "w1:p1",
  terminal_id: "term_1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused: false,
  agent_status: "blocked",
  revision: 0,
  ...over,
});

/** The two reads a notification makes of the mirror, and nothing else. */
function storeWith(pane: PaneInfo | undefined, label = "project"): SessionStore {
  return {
    pane: () => pane,
    workspace: () => ({ label }),
    instance: () => undefined,
  } as unknown as SessionStore;
}

const blocked = (over: Partial<StatusChange> = {}): StatusChange => ({ paneId: "w1:p1", workspaceId: "w1", from: "working", to: "blocked", ...over });

describe("when a notification fires", () => {
  // Pre-release bug hunt: answered, working for a second, blocked again — the
  // second question landed inside the 5s window, was dropped, and nothing
  // re-checked it, so the pane waited with no notification at all.
  test("a second question within 5 s is notified once the window ends", async () => {
    jest.useFakeTimers();
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    const pane = paneInfo();
    const store = storeWith(pane);

    await push.notifyStatusChange(blocked(), store);
    expect(requests).toHaveLength(1);

    jest.advanceTimersByTime(1_300);
    await push.notifyStatusChange(blocked(), store);
    await push.notifyStatusChange(blocked({ from: "blocked" }), store);
    await settle();
    expect(requests).toHaveLength(1);

    jest.advanceTimersByTime(3_700);
    await settle();
    expect(requests).toHaveLength(2);

    // Several changes inside one window add up to one notification, not more.
    jest.advanceTimersByTime(20_000);
    await settle();
    expect(requests).toHaveLength(2);
  });

  test("a second question answered before the window ends is not notified late", async () => {
    jest.useFakeTimers();
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    const pane = paneInfo();
    const store = storeWith(pane);

    await push.notifyStatusChange(blocked(), store);
    jest.advanceTimersByTime(1_000);
    await push.notifyStatusChange(blocked(), store);
    pane.agent_status = "working";
    jest.advanceTimersByTime(4_000);
    await settle();
    expect(requests).toHaveLength(1);
  });

  test("the startup baseline is not news", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    await push.notifyStatusChange(blocked({ from: undefined, initial: true }), storeWith(paneInfo()));
    expect(requests).toHaveLength(0);
  });

  // Pre-release bug hunt: a new agent that blocked within one snapshot, or a
  // pane restored after a herdr restart, was first seen already blocked, read
  // as the startup baseline, and never notified.
  test("a pane first seen already blocked after startup is notified once", async () => {
    const agent = (over: Partial<AgentInfo>): AgentInfo => ({ ...paneInfo(), state_change_seq: 1, ...over });
    const snapshot = (agents: AgentInfo[]): SessionSnapshot => ({
      version: "0.9.1", protocol: 22, workspaces: [{ workspace_id: "w1", number: 1, label: "project", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
      tabs: [], panes: agents.map(({ state_change_seq: _, ...pane }) => pane), agents, layouts: [],
    });
    const queue = [snapshot([]), snapshot([agent({})]), snapshot([agent({})])];
    const client = { rpc: async () => ({ snapshot: queue.shift() }) } as unknown as HerdrClient;
    const store = new SessionStore(client);
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    const sends: Promise<void>[] = [];
    store.on("status", (change) => sends.push(push.notifyStatusChange(change, store)));

    await store.resync();
    await store.resync();
    await store.resync();
    await Promise.all(sends);
    expect(requests).toHaveLength(1);
  });
});

describe("expo tokens", () => {
  test("accepts both token spellings Expo issues", () => {
    const push = service();
    expect(push.isExpoToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(push.isExpoToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
  });

  test("rejects anything else, rather than storing a token that can never work", () => {
    const push = service();
    expect(push.isExpoToken("not-a-token")).toBe(false);
    expect(push.isExpoToken("ExpoPushToken[]")).toBe(false);
    expect(push.isExpoToken(42)).toBe(false);
    expect(push.isExpoToken(null)).toBe(false);
  });

  test("registering twice leaves one token", () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    push.subscribeExpo("ExpoPushToken[abc]");
    expect(push.count()).toBe(1);
    push.unsubscribeExpo("ExpoPushToken[abc]");
    expect(push.count()).toBe(0);
  });

  // Pre-release bug hunt: a 100,019-character token was stored and uploaded
  // with every notification.
  test("a token of any length is refused", () => {
    const push = service();
    expect(push.isExpoToken(`ExponentPushToken[${"x".repeat(100_000)}]`)).toBe(false);
    expect(push.isExpoToken(`ExponentPushToken[${"x".repeat(200)}]`)).toBe(true);
    expect(push.isSubscription({ endpoint: `https://push.example/${"x".repeat(100_000)}`, keys: { p256dh: "x", auth: "y" } })).toBe(false);
    expect(push.isSubscription({ endpoint: "https://push.example/a", keys: { p256dh: "x".repeat(100_000), auth: "y" } })).toBe(false);
    expect(push.isSubscription({ endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" } })).toBe(true);
  });

  test("an owner's new registration replaces its old one rather than adding to it", () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[old]", "phone");
    push.subscribeExpo("ExpoPushToken[new]", "phone");
    push.subscribeExpo("ExpoPushToken[other]", "other phone");
    push.subscribe({ endpoint: "https://push.example/old", keys: { p256dh: "x", auth: "y" } }, "browser");
    push.subscribe({ endpoint: "https://push.example/new", keys: { p256dh: "x", auth: "y" } }, "browser");
    expect(push.count()).toBe(3);
    push.unsubscribeExpo("ExpoPushToken[new]", "phone");
    push.unsubscribe("https://push.example/new", "browser");
    expect(push.count()).toBe(1);
  });
});

// Pre-release bug hunt: a passcode session's registrations outlived the
// session. Its expiry was only inside the cookie, so after it ran out the
// phone kept being notified and no logout could name the rows.
describe("registrations that belong to a passcode session", () => {
  test("end with the session", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[expired]", "session:a", Date.now() - 1);
    push.subscribeExpo("ExpoPushToken[live]", "session:b", Date.now() + 60_000);
    push.subscribeExpo("ExpoPushToken[device]", "device-1", null);
    const requests = expoRequests();
    expect(await push.sendTest()).toBe(2);
    expect((requests[0] as { to: string }[]).map((m) => m.to).sort()).toEqual(["ExpoPushToken[device]", "ExpoPushToken[live]"]);
    expect(push.count()).toBe(2);
  });

  test("renew with the session that registers them again", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[phone]", "session:old", Date.now() - 1);
    push.subscribeExpo("ExpoPushToken[phone]", "session:new", Date.now() + 60_000);
    const requests = expoRequests();
    expect(await push.sendTest()).toBe(1);
    expect(requests).toHaveLength(1);
  });

  test("from before expiry was stored end within one session lifetime, and a device's never", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE device_expo_push_token (token TEXT PRIMARY KEY, owner TEXT NOT NULL, added_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE device_push_subscription (endpoint TEXT PRIMARY KEY, owner TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, added_at INTEGER NOT NULL)");
    db.run("INSERT INTO device_expo_push_token VALUES ('ExpoPushToken[s]', 'session:abc', 0), ('ExpoPushToken[d]', 'device-1', 0)");
    db.run("INSERT INTO device_push_subscription VALUES ('https://push.example/s', 'session:abc', 'x', 'y', 0)");
    const before = Date.now();
    new PushService(db, { vapid: null, sessionTtlMs: 60_000 } as Config);
    const rows = db.query<{ token: string; expires_at: number | null }, []>("SELECT token, expires_at FROM device_expo_push_token ORDER BY token").all();
    expect(rows[0]).toEqual({ token: "ExpoPushToken[d]", expires_at: null });
    expect(rows[1]!.expires_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(rows[1]!.expires_at).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(db.query<{ expires_at: number }, []>("SELECT expires_at FROM device_push_subscription").get()!.expires_at).toBeGreaterThanOrEqual(before + 60_000);
  });
});

describe("delivery", () => {
  test("sends to Expo even with no VAPID keys configured", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");

    let sent: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ status: "ok" }] }));
    }) as unknown as typeof fetch;

    expect(await push.sendTest()).toBe(1);
    expect(sent).toMatchObject([{ to: "ExpoPushToken[abc]", title: "Shahi", data: { serverId: expect.any(String) } }]);
  });

  test("drops a token the device no longer holds", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[gone]");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
        }),
      )) as unknown as typeof fetch;

    expect(await push.sendTest()).toBe(0);
    // Dropped: kept, it would fail on every notification from here on.
    expect(push.count()).toBe(0);
  });

  test("keeps a token that failed for some other reason", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ status: "error", details: { error: "MessageRateExceeded" } }] }),
      )) as unknown as typeof fetch;

    expect(await push.sendTest()).toBe(0);
    expect(push.count()).toBe(1);
  });

  test("a push service that is down is not an error worth raising", async () => {
    jest.useFakeTimers();
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const sending = push.sendTest();
    for (const wait of [2_000, 10_000]) {
      await settle();
      jest.advanceTimersByTime(wait);
    }
    expect(await sending).toBe(0);
    // Tried again twice, then given up on: bounded, not forever.
    expect(attempts).toBe(3);
  });

  // Pre-release bug hunt: Expo refuses a request of more than 100 messages
  // whole, so with 102 tokens every send failed for every phone.
  test("past 100 tokens, every phone is still notified", async () => {
    const push = service();
    for (let i = 0; i < 101; i++) push.subscribeExpo(`ExpoPushToken[t${i}]`, `owner-${i}`);
    const requests: { to: string }[][] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)) as { to: string }[];
      requests.push(messages);
      if (messages.length > 100) return Response.json({ errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS" }] }, { status: 400 });
      // The second batch's only token is gone: its ticket maps back to it.
      return Response.json({ data: messages.map((m) => m.to === "ExpoPushToken[t100]" ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" }) });
    }) as unknown as typeof fetch;
    expect(await push.sendTest()).toBe(100);
    expect(requests.map((r) => r.length)).toEqual([100, 1]);
    expect(push.count()).toBe(100);
  });

  test("no tokens means no request at all", async () => {
    const push = service();
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await push.sendTest()).toBe(0);
    expect(called).toBe(false);
  });
});


test("retiring an owner excludes their token from future deliveries", async () => {
  const push = service();
  push.subscribeExpo("ExpoPushToken[revoked]", "a");
  push.subscribeExpo("ExpoPushToken[active]", "b");
  push.unsubscribeOwner("a");
  let sent: unknown;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({ data: [{ status: "ok" }] });
  }) as typeof fetch;
  expect(await push.sendTest()).toBe(1);
  expect(sent).toEqual([expect.objectContaining({ to: "ExpoPushToken[active]" })]);
});

// herdr gives a closed pane's id to the next new pane after a restart, and a
// notification carried only the pane id: tapped later, it opened whichever
// conversation had the id by then (pre-release bug hunt). It now names the
// occupant that was waiting.
test("a notification names the conversation that was waiting, not only its pane id", async () => {
  const push = service();
  push.subscribeExpo("ExpoPushToken[abc]");
  let sent: { data: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({ data: [{ status: "ok" }] });
  }) as typeof fetch;
  const store = {
    pane: () => ({ terminal_title: "claude" }),
    workspace: () => ({ label: "api" }),
    instance: (paneId: string) => (paneId === "w3:p1" ? "term_a" : undefined),
  } as unknown as SessionStore;
  await push.notifyStatusChange({ paneId: "w3:p1", workspaceId: "w3", from: "working", to: "blocked" } as never, store);
  expect(sent[0]?.data).toMatchObject({ paneId: "w3:p1", instanceId: "term_a" });
});

/** A PushService with real VAPID keys and web-push's send replaced. */
function webService(log?: PushLog) {
  const keys = webpush.generateVAPIDKeys();
  const push = new PushService(new Database(":memory:"), { vapid: { subject: "mailto:test@example.com", ...keys } } as Config, log);
  const sends: { payload: string; options: Record<string, unknown> }[] = [];
  const outcomes: unknown[] = [];
  webpush.sendNotification = (async (_subscription: unknown, payload: string, options: Record<string, unknown>) => {
    sends.push({ payload, options });
    const outcome = outcomes.shift();
    if (outcome) throw outcome;
    return { statusCode: 201, body: "", headers: {} };
  }) as unknown as typeof webpush.sendNotification;
  push.subscribe({ endpoint: "https://push.example/browser", keys: { p256dh: "x", auth: "y" } }, "browser");
  return { push, sends, outcomes };
}

const realSendNotification = webpush.sendNotification;
afterEach(() => {
  webpush.sendNotification = realSendNotification;
});

describe("what a notification carries", () => {
  // Pre-release bug hunt: a 1,900-character workspace label, sent twice,
  // took every notification from that workspace over the 4 KB both push
  // services allow, and they were refused silently.
  test("a long workspace label still fits in a notification", async () => {
    const label = "👩🏽‍💻مرحبا".repeat(400);
    const expo = service();
    expo.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    await expo.notifyStatusChange(blocked(), storeWith(paneInfo({ terminal_title_stripped: "ش".repeat(2_400) }), label));
    const message = (requests[0] as { title: string; body: string; data: object }[])[0]!;
    expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThan(2_048);
    expect(message.title.endsWith("… needs you")).toBe(true);
    // Cut between graphemes: never inside the family-of-code-points emoji.
    const kept = message.title.slice(0, -"… needs you".length);
    const boundaries = new Set([0]);
    let at = 0;
    for (const { segment } of new Intl.Segmenter().segment(label)) boundaries.add((at += segment.length));
    expect(label.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(boundaries.has(kept.length)).toBe(true);
    expect(message.data).toEqual({ paneId: "w1:p1", serverId: expect.any(String) });

    const { push, sends } = webService();
    await push.notifyStatusChange(blocked(), storeWith(paneInfo({ terminal_title_stripped: "ش".repeat(2_400) }), label));
    expect(new TextEncoder().encode(sends[0]!.payload).length).toBeLessThan(2_048);
    expect(Object.keys(JSON.parse(sends[0]!.payload)).sort()).toEqual(["body", "paneId", "serverId", "title"]);
  });

  // Pre-release bug hunt: the dashboard read "Refactor billing"; the
  // notification for the same pane read "w1:p1".
  test("a labelled pane with no terminal title is named by its label, as on the dashboard", async () => {
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    await push.notifyStatusChange(blocked(), storeWith(paneInfo({ label: "Refactor billing" })));
    expect((requests[0] as { body: string }[])[0]!.body).toBe("Refactor billing");
  });

  // Pre-release bug hunt: Web Push went out with web-push's defaults, four
  // weeks and normal urgency, and Expo with none, so a phone offline for a
  // while was told about questions answered long ago.
  test("a notification expires within the hour, is urgent, and replaces its pane's queued one", async () => {
    const expo = service();
    expo.subscribeExpo("ExpoPushToken[abc]");
    const requests = expoRequests();
    await expo.notifyStatusChange(blocked(), storeWith(paneInfo()));
    expect((requests[0] as object[])[0]).toMatchObject({ ttl: 3_600, priority: "high" });

    const { push, sends } = webService();
    await push.notifyStatusChange(blocked(), storeWith(paneInfo()));
    await push.notifyStatusChange(blocked({ paneId: "w1:p2" }), storeWith(paneInfo({ pane_id: "w1:p2" })));
    expect(sends[0]!.options).toMatchObject({ TTL: 3_600, urgency: "high", timeout: 15_000 });
    const [first, second] = sends.map((s) => s.options.topic as string);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(second).not.toBe(first);
  });
});

describe("delivery failures", () => {
  // Pre-release bug hunt: every failure collapsed to a quiet 0, so nothing in
  // the log or the diagnostics said notifications had stopped.
  test("are logged and counted without a token, an endpoint or a payload", async () => {
    const rows: Record<string, unknown>[] = [];
    const observability = new Observability((row) => rows.push(row as Record<string, unknown>));
    const push = new PushService(new Database(":memory:"), { vapid: null } as Config, observability.event);
    push.subscribeExpo("ExpoPushToken[secret-token]", "a");
    push.subscribeExpo("ExpoPushToken[too-big]", "b");
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const messages = JSON.parse(String(init.body)) as { to: string }[];
      return Response.json({ data: messages.map((m) => m.to.includes("too-big") ? { status: "error", message: "private detail", details: { error: "MessageTooBig" } } : { status: "ok" }) });
    }) as unknown as typeof fetch;
    await push.notifyStatusChange(blocked(), storeWith(paneInfo({ terminal_title_stripped: "private title" }), "private space"));

    globalThis.fetch = (async () => Response.json({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "private detail" }] }, { status: 400 })) as unknown as typeof fetch;
    expect(await push.sendTest()).toBe(0);

    expect(rows.map(({ event, channel, count, reason, status }) => ({ event, channel, count, reason, status }))).toEqual([
      { event: "push.sent", channel: "expo", count: 1, reason: undefined, status: undefined },
      { event: "push.failed", channel: "expo", count: 1, reason: "MessageTooBig", status: undefined },
      { event: "push.failed", channel: "expo", count: 2, reason: "push refused", status: 400 },
    ]);
    expect(observability.snapshot().events).toMatchObject({ "push.sent": 1, "push.failed": 2 });
    expect(JSON.stringify(rows)).not.toMatch(/secret-token|too-big|private/);
  });

  test("a refusal for now is retried a bounded number of times; a timeout is not", async () => {
    jest.useFakeTimers();
    const logged: string[] = [];
    const push = new PushService(new Database(":memory:"), { vapid: null } as Config, (event, fields) => logged.push(`${event}:${fields.reason ?? fields.count}`));
    push.subscribeExpo("ExpoPushToken[abc]");
    const answers = [503, 429, 200];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const status = answers.shift()!;
      const messages = JSON.parse(String(init.body)) as unknown[];
      return status === 200 ? Response.json({ data: messages.map(() => ({ status: "ok" })) }) : new Response("busy", { status });
    }) as unknown as typeof fetch;
    const sending = push.sendTest();
    for (const wait of [2_000, 10_000]) {
      await settle();
      jest.advanceTimersByTime(wait);
    }
    expect(await sending).toBe(1);
    expect(answers).toEqual([]);

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await push.sendTest()).toBe(0);
    expect(attempts).toBe(1);
    expect(logged).toEqual(["push.sent:1", "push.failed:push timeout"]);
  });

  test("a browser that is gone is dropped and logged; one that is busy is tried again", async () => {
    jest.useFakeTimers();
    const logged: unknown[] = [];
    const { push, sends, outcomes } = webService((event, fields) => logged.push({ event, ...fields }));
    outcomes.push(Object.assign(new Error("busy"), { statusCode: 503 }));
    const sending = push.sendTest();
    await settle();
    jest.advanceTimersByTime(2_000);
    expect(await sending).toBe(1);
    expect(sends).toHaveLength(2);

    outcomes.push(Object.assign(new Error("gone"), { statusCode: 410 }));
    expect(await push.sendTest()).toBe(0);
    expect(push.count()).toBe(0);
    expect(logged).toEqual([
      { event: "push.sent", channel: "web", count: 1 },
      { event: "push.failed", channel: "web", count: 1, reason: "subscription gone", status: 410 },
    ]);
  });
});
