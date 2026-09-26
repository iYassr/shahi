import { test, expect } from "bun:test";
import { limitKey, signup } from "./src/signup";
const request = (body: unknown, origin = "https://getshahi.dev") => new Request("https://getshahi.dev/api/ios-beta", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const valid = { email: "tester@example.com", consent: true };
test("sends only the validated applicant address and reports delivery acceptance", async () => {
  const sent: string[] = [];
  const r = await signup(request(valid), { limit: async () => true, send: async e => { sent.push(e); } });
  expect(r.status).toBe(200); expect(sent).toEqual([valid.email]); expect(r.headers.get("Cache-Control")).toBe("no-store");
  // The page shows this as the form's result, so it names what arrives and where.
  expect((await r.json()).message).toBe("Request sent. We’ll email tester@example.com when your TestFlight invite is ready.");
});
test("rejects invalid input, header injection, missing consent, traps and cross-origin requests", async () => {
  let sent = false;
  const deps = { limit: async () => true, send: async () => { sent = true; } };
  for (const body of [null, {}, { ...valid, email: 'bad\r\nBcc: x@example.com' }, { ...valid, consent: false }, { ...valid, website: "spam" }]) expect((await signup(request(body), deps)).status).toBe(400);
  expect((await signup(request(valid, "https://other.example"), deps)).status).toBe(403);
  expect(sent).toBe(false);
});
test("rate limits and oversized bodies never send", async () => {
  const send = async () => { throw Error("must not send"); };
  expect((await signup(request(valid), { limit: async () => false, send })).status).toBe(429);
  expect((await signup(request({ ...valid, email: "x".repeat(3000) }), { limit: async () => true, send })).status).toBe(413);
});
test("email failure does not claim signup success", async () => {
  expect((await signup(request(valid), { limit: async () => true, send: async () => { throw Error("delivery failed"); } })).status).toBe(503);
});

// Review finding F80, applied to the signup form: one IPv6 host holds a /64,
// so its addresses share one budget; nothing else is merged.
test("rate limits an IPv6 host by its /64, and every other address as given", async () => {
  const keys: string[] = [];
  const deps = { limit: async (key: string) => { keys.push(key); return false; }, send: async () => {} };
  for (const ip of ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff::9"]) {
    await signup(new Request("https://getshahi.dev/api/beta", { method: "POST", headers: { Origin: "https://getshahi.dev", "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: "{}" }), deps);
  }
  expect(keys).toEqual(["2001:db8:1:2::/64", "2001:db8:1:2::/64"]);
  expect(limitKey("203.0.113.9")).toBe("203.0.113.9");
  expect(limitKey("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
  expect(limitKey("not an address")).toBe("not an address");
  expect(limitKey("2001:db8:1:3::1")).not.toBe(limitKey("2001:db8:1:2::1"));
});

// site/public/_headers reaches static assets only, never a Worker's answer, so
// this route sent no-store and nosniff alone, and its 405 named no method
// (pre-release bug hunt, B99).
test("every answer carries the site's baseline headers, and a refused method is told the one to use", async () => {
  const deps = { limit: async () => true, send: async () => {} };
  const answers = [
    await signup(request(valid), deps),
    await signup(request({}), deps),
    await signup(new Request("https://getshahi.dev/api/ios-beta"), deps),
    await signup(new Request("https://getshahi.dev/api/ios-beta", { method: "OPTIONS" }), deps),
  ];
  expect(answers.map(r => r.status)).toEqual([200, 400, 405, 405]);
  for (const r of answers) {
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(r.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(r.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
  }
  expect(answers.map(r => r.headers.get("Allow"))).toEqual([null, null, "POST", "POST"]);
  // Never over plain HTTP, where a host must not send it (RFC 6797 §7.2).
  expect((await signup(new Request("http://127.0.0.1:8787/api/ios-beta"), deps)).headers.get("Strict-Transport-Security")).toBeNull();
});
