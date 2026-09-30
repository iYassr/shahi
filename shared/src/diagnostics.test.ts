import { describe, expect, test } from "bun:test";
import { DiagnosticBudget, ReaderHealth, readerFailure, readerProvider, sanitizeDiagnosticEvent, type ReaderIncident } from "./diagnostics";

describe("Reader incidents", () => {
  const harness = () => { const events: ReaderIncident[] = []; return { events, health: new ReaderHealth(event => events.push(event)) }; };
  test("one report after a persistent failure, and one recovery", () => {
    const { events, health } = harness();
    for (let now = 0; now <= 90_000; now += 2500) health.observe("codex", "reader_session_missing", true, now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "codex", reason: "reader_session_missing", durationMs: 30_000, recovered: false });
    health.observe("codex", null, true, 91_000);
    health.observe("codex", null, true, 92_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.recovered).toBe(true);
  });
  test("a new empty conversation and transient lookup failure are not incidents", () => {
    const { events, health } = harness();
    health.observe("claude", "reader_transcript_missing", true, 0);
    health.observe("claude", "reader_transcript_missing", true, 2500);
    health.observe("claude", null, true, 5000);
    health.observe("claude", null, true, 60_000);
    expect(events).toEqual([]);
  });
  test("background time, disconnected state and unsupported agents do not count", () => {
    for (const stop of ["background", "gap", "unknown"] as const) {
      const { events, health } = harness();
      health.observe("cursor", "reader_unavailable", true, 0);
      health.observe("cursor", "reader_unavailable", true, 2500);
      if (stop === "background") health.observe("cursor", "reader_unavailable", false, 5000);
      if (stop === "unknown") health.observe(null, "reader_unavailable", true, 5000);
      health.observe("cursor", "reader_unavailable", true, 120_000);
      expect(events).toEqual([]);
    }
  });
  test("changing a provider or failure reason starts a new observation window", () => {
    const { events, health } = harness();
    health.observe("claude", "reader_unavailable", true, 0);
    health.observe("claude", "reader_unavailable", true, 15_000);
    health.observe("codex", "reader_unavailable", true, 30_000);
    health.observe("codex", "server_error", true, 40_000);
    expect(events).toEqual([]);
  });
  test("oversized responses report once despite the 30-second polling backoff", () => {
    const { events, health } = harness();
    health.observe("opencode", "response_too_large", true, 0);
    health.observe("opencode", "response_too_large", true, 30_000);
    expect(events).toHaveLength(1);
  });
  test("reporter failures cannot break reading", () => {
    const health = new ReaderHealth(() => { throw new Error("offline"); });
    expect(() => health.observe("codex", "response_too_large", true)).not.toThrow();
  });
  test("authentication and incompatible-server responses belong to connection recovery", () => {
    for (const status of [401, 403, 409, 426]) expect(readerFailure(status)).toBeNull();
    expect(readerFailure(404, "private arbitrary error")).toBe("reader_unavailable");
    expect(readerFailure(500)).toBe("server_error");
  });
});

describe("outbound privacy", () => {
  test("scrubs nested content, credentials, request data and unknown future SDK fields", () => {
    const secret = "SYNTHETIC_PRIVATE_CANARY";
    const event = { event_id: "a".repeat(32), timestamp: 123, environment: "production", release: "shahi-web@abc123", platform: "javascript",
      message: secret, user: { id: secret, email: secret, ip_address: secret }, request: { url: secret, headers: { Cookie: secret }, data: secret },
      breadcrumbs: [{ message: secret }], extra: { text: secret }, future_sdk_field: secret,
      contexts: { device: { name: secret, id: secret, model: "iPhone18,1" }, app: { app_name: secret, app_version: "1.2.3" }, arbitrary: { secret } },
      exception: { values: [{ type: "TypeError", value: secret, mechanism: { data: { secret } }, stacktrace: { frames: [{ filename: "https://example.test/pwa/assets/index-abcdefgh.js?token=" + secret,
        function: "render", lineno: 42, colno: 10, vars: { secret }, context_line: secret, pre_context: [secret] }] } }] } };
    const safe = sanitizeDiagnosticEvent(event)!;
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain("example.test");
    expect(safe.exception).toMatchObject({ values: [{ type: "TypeError", stacktrace: { frames: [{ filename: "app:///index-abcdefgh.js", lineno: 42, colno: 10 }] } }] });
    expect(event.message).toBe(secret);
  });
  test("keeps debug IDs and matching bundle names for source-map symbolication", () => {
    const event = { message: "Shahi diagnostics verification", debug_meta: { images: [{ type: "sourcemap", code_file: "https://getshahi.dev/pwa/assets/index-abcdefgh.js", debug_id: "2e8d8c40-6ddd-47ec-a2c7-2a6ae43fca57", extra: "PRIVATE" }] } };
    expect(sanitizeDiagnosticEvent(event)?.debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: "app:///index-abcdefgh.js", debug_id: "2e8d8c40-6ddd-47ec-a2c7-2a6ae43fca57" }] });
  });
  test("accepts only bounded operational Reader dimensions", () => {
    const safe = sanitizeDiagnosticEvent({ message: "private text", tags: { provider: "codex", reader_reason: "reader_session_missing", reader_recovered: "false", computer_version: "0.3.6", herdr_version: "/Users/private", pane: "private pane", transport: "relay" }, extra: { attempts: 13, duration_ms: 30_000, prompt: "private" } });
    expect(safe?.message).toBe("Reader conversation unavailable");
    expect(safe?.fingerprint).toEqual(["reader", "codex", "reader_session_missing", "failed"]);
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(safe?.extra).toEqual({ attempts: 13, duration_ms: 30_000 });
  });
  test("drops arbitrary messages, transactions and replay events", () => {
    for (const event of [{ message: "terminal text" }, { type: "transaction" }, { type: "replay_event" }]) expect(sanitizeDiagnosticEvent(event)).toBeNull();
  });
  test("a broken device has a bounded hourly error budget", () => {
    const budget = new DiagnosticBudget();
    for (let n = 0; n < 20; n++) expect(budget.allow(100)).toBe(true);
    expect(budget.allow(200)).toBe(false);
    expect(budget.allow(3_600_001)).toBe(true);
  });
});

test("herdr's Antigravity kind participates in Reader recovery and monitoring", () => {
  expect(readerProvider("agy")).toBe("antigravity");
  expect(readerProvider("antigravity")).toBe("antigravity");
  expect(readerProvider("shell")).toBeNull();
});
