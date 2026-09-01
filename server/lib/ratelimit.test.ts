import { describe, expect, test } from "bun:test";
import { RateLimiter, clientAddress, isRateLimitedPath } from "./ratelimit";

describe("RateLimiter", () => {
  test("allows up to the limit in a window, then refuses with a wait", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1_000 });
    expect(limiter.hit("a", 0)).toBeNull();
    expect(limiter.hit("a", 10)).toBeNull();
    expect(limiter.hit("a", 20)).toBeNull();
    expect(limiter.hit("a", 30)).toBe(970);
  });

  test("keys are independent, so one noisy address does not lock out another", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.hit("a", 0)).toBeNull();
    expect(limiter.hit("a", 1)).not.toBeNull();
    expect(limiter.hit("b", 1)).toBeNull();
  });

  test("the window reopens once it has passed", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.hit("a", 0)).toBeNull();
    expect(limiter.hit("a", 999)).not.toBeNull();
    expect(limiter.hit("a", 1_000)).toBeNull();
  });

  test("the table is bounded: the stalest keys go first", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.hit("old", 0);
    limiter.hit("mid", 1);
    limiter.hit("new", 2);
    // "old" was evicted, so it starts a fresh window and is allowed again.
    expect(limiter.hit("old", 3)).toBeNull();
    // "new" is still remembered and refused.
    expect(limiter.hit("new", 3)).not.toBeNull();
  });
});

describe("isRateLimitedPath", () => {
  test("matches exact paths and subtrees, and nothing else", () => {
    expect(isRateLimitedPath("/api/meta")).toBe(true);
    expect(isRateLimitedPath("/api/auth/status")).toBe(true);
    expect(isRateLimitedPath("/api/pair/start")).toBe(true);
    expect(isRateLimitedPath("/api/meta/x")).toBe(false);
    expect(isRateLimitedPath("/api/session")).toBe(false);
    expect(isRateLimitedPath("/api/auth/login")).toBe(false);
  });
});

describe("clientAddress", () => {
  test("believes x-forwarded-for only from a loopback peer, and only its last hop", () => {
    // The proxy appends the address it saw; anything before it was typed by
    // the client. A limiter keyed on the first entry was resettable per request.
    expect(clientAddress("127.0.0.1", "1.2.3.4, 100.64.0.7")).toBe("100.64.0.7");
    expect(clientAddress("127.0.0.1", "spoofed, also-spoofed, 100.64.0.7")).toBe("100.64.0.7");
    expect(clientAddress("::1", "100.64.0.7")).toBe("100.64.0.7");
    // A remote peer's header is just a header.
    expect(clientAddress("100.64.0.9", "1.2.3.4")).toBe("100.64.0.9");
    expect(clientAddress("127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientAddress(null, "1.2.3.4")).toBe("unknown");
  });
});
