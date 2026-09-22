import { readFileSync } from "node:fs";
const credentials = JSON.parse(readFileSync(process.env.HOME + "/.config/shahi-review-demo/credentials.json", "utf8"));
const base = "https://review.getshahi.dev";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const page = await fetch(base); assert(page.ok && (await page.text()).includes('name="password"'), "Login page missing");
for (const path of ["/health", "/pair", "/_state", "/_restart"]) {
 const r = await fetch(base + path, { method: path === "/pair" || path === "/_restart" ? "POST" : "GET" });
 assert(r.status === 401 || r.status === 404, `Unauthenticated ${path} was exposed`);
}
const form = new URLSearchParams({ username: "reviewer", password: credentials.REVIEW_PASSWORD });
const denied = await fetch(base + "/login", { method: "POST", body: form, redirect: "manual", headers: { origin: "https://untrusted.example" } });
assert(denied.status === 403, "Cross-origin sign-in not rejected");
const login = await fetch(base + "/login", { method: "POST", body: form, redirect: "manual", headers: { origin: base } });
assert(login.status === 303, `Sign-in failed: ${login.status}`);
const cookie = login.headers.get("set-cookie")!;
assert(cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Strict"), "Unsafe session cookie");
const headers = { cookie: cookie.split(";")[0]! };
const review = await fetch(base, { headers });
assert(review.ok && (await review.text()).includes("simulated replies"), "Demo disclosure missing");
const csrf = await fetch(base + "/pair", { method: "POST", headers: { ...headers, origin: "https://untrusted.example" } });
assert(csrf.status === 403, "Cross-origin pairing not rejected");
const operator = await fetch(base + "/_restart", { method: "POST", headers });
assert(operator.status === 404, "Reviewer can restart host");
console.log("PASS login, protected routes, secure cookie, origin checks and operator separation");
