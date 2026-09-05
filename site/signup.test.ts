import { test, expect } from "bun:test";
import { signup } from "./src/signup";
const request = (body: unknown, origin = "https://getshahi.dev") => new Request("https://getshahi.dev/api/ios-beta", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const valid = { email: "tester@example.com", consent: true };
test("sends only the validated applicant address and reports delivery acceptance", async () => {
  const sent: string[] = [];
  const r = await signup(request(valid), { limit: async () => true, send: async e => { sent.push(e); } });
  expect(r.status).toBe(200); expect(sent).toEqual([valid.email]); expect(r.headers.get("Cache-Control")).toBe("no-store");
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
