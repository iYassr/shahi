import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayLink, pairingTarget, deviceTarget, type RelayIdentity } from "../shared/src/relay-client";
import { SHAHI_API_VERSION } from "../shared/src/index";
const dir = join(process.env.HOME!, ".config/shahi-review-demo");
const secrets = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
const remote = process.argv.includes("--remote");
const base = remote ? "https://review.getshahi.dev" : "http://127.0.0.1:9988";
const headers = { authorization: remote ? `Basic ${btoa(`reviewer:${secrets.REVIEW_PASSWORD}`)}` : `Bearer ${secrets.INTERNAL_TOKEN}` };
const health = await fetch(`${base}/health`, { headers });
if (!health.ok || !(await health.json() as any).ready) throw new Error("Demo is not ready");
console.log("PASS healthy isolated computer");
let identity: RelayIdentity;
if (process.argv.includes("--resume")) identity = JSON.parse(readFileSync(join(dir, remote ? "remote-device.json" : "local-device.json"), "utf8"));
else {
 const page = await fetch(`${base}/pair`, { method: "POST", headers });
 const html = await page.text();
 const match = html.match(/<textarea[^>]*>([^<]+)<\/textarea>/);
 if (!match) throw new Error(`No pairing code (HTTP ${page.status})`);
 const code = new URL(match[1]!.replaceAll("&amp;", "&"));
 const p = new URLSearchParams(code.hash.slice(1));
 const pairing = new RelayLink(pairingTarget(p.get("relay")!, p.get("server")!, p.get("secret")!));
 try {
  const response = await pairing.request({ method: "POST", path: "/api/pair/claim", headers: { "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) }, body: new TextEncoder().encode(JSON.stringify({ secret: p.get("secret"), deviceName: "Review verification" })) }, 30_000);
  const claim = await response.json() as any;
  if (!response.ok || !claim.deviceSecret) throw new Error("Encrypted pairing failed");
  identity = { relay: p.get("relay")!, serverId: p.get("server")!, deviceId: claim.deviceId, deviceSecret: claim.deviceSecret };
  writeFileSync(join(dir, remote ? "remote-device.json" : "local-device.json"), JSON.stringify(identity), { mode: 0o600 });
  console.log("PASS one-time pairing through encrypted relay");
 } finally { pairing.close(); }
}
const link = new RelayLink(deviceTarget(identity));
async function api(path: string, body?: unknown, timeout = 30_000): Promise<any> {
 const r = await link.request({ method: body ? "POST" : "GET", path, headers: { "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) }, body: body ? new TextEncoder().encode(JSON.stringify(body)) : null }, timeout);
 const result = await r.json();
 if (!r.ok) throw new Error(`${path} failed: HTTP ${r.status} ${JSON.stringify(result)}`);
 return result;
}
try {
 const session = await api("/api/session");
 console.log("PASS saved-device reconnect; workspaces", session.workspaces?.length);
 const agents = await api("/api/agents");
 console.log("Agent discovery", JSON.stringify(agents));
 if (process.argv.includes("--create")) {
  const mode = process.argv.find(x => x.startsWith("--mode="))?.slice(7) ?? "full-auto";
  const started = await api("/api/agents/start", { clientRequestId: crypto.randomUUID(), workspaceId: session.workspaces[0].id ?? session.workspaces[0].workspaceId, kind: "codex", cwd: "/home/demo/workspace", name: "Simulated demo", label: "Simulated demo", mode }, 325_000);
  writeFileSync(join(dir, remote ? "remote-agent.json" : "local-agent.json"), JSON.stringify(started), { mode: 0o600 });
  console.log("Agent creation result", JSON.stringify(started));
 }
 if (process.argv.includes("--prompt")) {
  const started = JSON.parse(readFileSync(join(dir, remote ? "remote-agent.json" : "local-agent.json"), "utf8"));
  const path = `/api/panes/${encodeURIComponent(started.paneId)}`;
  await api(`${path}/prompt`, { text: "list files", clientMessageId: crypto.randomUUID() });
  const deadline = Date.now() + 60_000;
  let complete = false;
  while (Date.now() < deadline) {
   try {
    const session = await api(`${path}/session`);
    const text = JSON.stringify(session);
    if (text.includes("Simulated demo response") && text.includes("README.md")) { complete = true; console.log("PASS real tool result and labeled simulated reply in reader"); break; }
   } catch {}
   await Bun.sleep(1500);
  }
  if (!complete) throw new Error("Simulated conversation did not complete within one minute");
 }
} finally { link.close(); }
