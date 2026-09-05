import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PushService } from "./push";
import type { Config } from "./config";

/** In memory, so a test run never touches the real subscription store. */
const service = (vapid: Config["vapid"] = null) =>
  new PushService(new Database(":memory:"), { vapid } as Config);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
    expect(sent).toMatchObject([{ to: "ExpoPushToken[abc]", title: "Shahi" }]);
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
