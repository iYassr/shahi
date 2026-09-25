import { afterEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PushService } from "./push";
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
    const push = service();
    push.subscribeExpo("ExpoPushToken[abc]");
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await push.sendTest()).toBe(0);
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
