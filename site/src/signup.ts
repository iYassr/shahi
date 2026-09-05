interface Dependencies {
  limit(key: string): Promise<boolean>;
  send(email: string): Promise<void>;
}
const reply = (status: number, message: string) => Response.json({ message }, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(status === 429 ? { "Retry-After": "60" } : {}) },
});

export async function signup(request: Request, deps: Dependencies): Promise<Response> {
  if (request.method !== "POST") return reply(405, "Use the signup form to register.");
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403, "Submit the form from the Shahi website.");
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply(415, "Send a JSON form submission.");
  if (!await deps.limit(request.headers.get("CF-Connecting-IP") ?? "unknown")) return reply(429, "Too many attempts. Please try again in a minute.");
  // Bound the stream too: Content-Length is optional and cannot enforce a limit.
  const reader = request.body?.getReader();
  if (!reader) return reply(400, "Enter your email address.");
  let raw = "", size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2048) { await reader.cancel(); return reply(413, "The submission is too large."); }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  let body: { email?: unknown; website?: unknown; consent?: unknown };
  try { body = JSON.parse(raw); } catch { return reply(400, "Check your email address and try again."); }
  if (!body || typeof body !== "object") return reply(400, "Enter your email address.");
  if (body.website) return reply(400, "Unable to accept this submission.");
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email)) return reply(400, "Enter a valid email address.");
  if (body.consent !== true) return reply(400, "Please agree to receive email about the iOS beta.");
  try { await deps.send(email); }
  catch { return reply(503, "We couldn’t send your request. Please try again, or email support@getshahi.dev."); }
  return reply(200, "Request sent. We’ll email you when a TestFlight place is available.");
}
