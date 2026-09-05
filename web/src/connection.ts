import { SHAHI_API_VERSION, type PairingPayload } from "@shahi/shared";
import { RelayLink, deviceTarget, pairingTarget, type RelayIdentity } from "@shahi/shared/relay-client";
import { parsePairingUrl } from "@shahi/shared/pairing";

export const hosted = import.meta.env?.BASE_URL === "/pwa/";
let identity: RelayIdentity | null = null;
let link: RelayLink | null = null;
let remembered = false;
let generation = 0;
const blobs = new Set<string>();
const DB = "shahi-browser-device";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("This browser could not save the device. Use a private session instead."));
  });
}
async function savedIdentity(value?: RelayIdentity | null): Promise<RelayIdentity | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("identity", value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("identity");
      const request = value === undefined ? store.get("current") : value === null ? store.delete("current") : store.put(value, "current");
      tx.oncomplete = () => resolve(value === undefined ? request.result ?? null : value);
      tx.onerror = () => reject(new Error("Could not update this browser's saved pairing."));
      tx.onabort = tx.onerror;
    });
  } finally { db.close(); }
}

// Serialize persistence with removal: a late pairing write must never resurrect
// credentials after logout, revocation, or a newer pairing attempt.
let credentialWrites: Promise<unknown> = Promise.resolve();
function persistIdentity(value: RelayIdentity | null, expectedGeneration: number): Promise<void> {
  const operation = credentialWrites.then(async () => {
    if (expectedGeneration === generation) await savedIdentity(value);
  });
  credentialWrites = operation.catch(() => {});
  return operation;
}

/** The secret never belongs in history, referrers, analytics or an API URL. */
export function takePairingFragment(): string {
  const hash = location.hash;
  if (!hash) return "";
  history.replaceState(null, "", location.pathname + location.search);
  try { return new URLSearchParams(hash.slice(1)).get("pair") ?? ""; } catch { return ""; }
}
export function readPairing(text: string): PairingPayload {
  const payload = parsePairingUrl(text.trim());
  if (!payload) throw new Error("Paste a complete Shahi pairing code printed below the QR.");
  const relay = new URL(payload.relay);
  if ((relay.protocol !== "https:" && !(relay.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname) && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    throw new Error("Browser pairing requires a secure HTTPS relay address without credentials or a path.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(payload.server)) throw new Error("This code has an invalid server identity.");
  pairingTarget(payload.relay, payload.server, payload.secret);
  return payload;
}
function activate(next: RelayIdentity): void {
  link?.close(); identity = next; link = new RelayLink(deviceTarget(next));
  link.subscribe({ onMessage() {}, onLink() {}, onExpired: () => { void forgetBrowser(); window.dispatchEvent(new Event("shahi:unauthorized")); } });
}
let restoration: Promise<void> | undefined;
export function restoreBrowser(): Promise<void> {
  return restoration ??= (async () => {
    if (!hosted) return;
    const before = generation;
    try {
      const saved = await savedIdentity();
      if (saved && before === generation) {
        readPairing(`shahi://pair#v=1&server=${encodeURIComponent(saved.serverId)}&relay=${encodeURIComponent(saved.relay)}&secret=${encodeURIComponent(saved.deviceSecret)}`);
        if (typeof saved.deviceId !== "string" || !saved.deviceId) return;
        activate(saved); remembered = true;
      }
    } catch { /* Storage may be unavailable in private mode; pairing still works in memory. */ }
  })();
}
export function browserConnection() { return { identity, remembered, link, generation }; }
export async function pairBrowser(text: string, name: string, remember: boolean): Promise<void> {
  if (!window.isSecureContext) throw new Error("Open Shahi over HTTPS to pair this browser.");
  const payload = readPairing(text);
  const attempt = ++generation;
  const pairing = new RelayLink(pairingTarget(payload.relay, payload.server, payload.secret));
  try {
    const meta = await pairing.request({ method: "GET", path: "/api/meta", headers: { "x-shahi-api": String(SHAHI_API_VERSION) }, body: null }, 15_000);
    const info = await meta.json() as { serverId?: string; error?: string };
    if (!meta.ok || info.serverId !== payload.server) throw new Error(info.error ?? "The computer's identity does not match this code.");
    const reply = await pairing.request({ method: "POST", path: "/api/pair/claim", headers: { "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) }, body: new TextEncoder().encode(JSON.stringify({ secret: payload.secret, deviceName: name.trim() || "Web browser" })) }, 15_000);
    const result = await reply.json() as { deviceId?: string; deviceSecret?: string; error?: string };
    if (!reply.ok || !result.deviceId || !result.deviceSecret) throw new Error(result.error ?? "Pairing failed. Print a fresh code and try again.");
    if (attempt !== generation) return;
    const next = { relay: payload.relay, serverId: payload.server, deviceId: result.deviceId, deviceSecret: result.deviceSecret };
    activate(next); remembered = false;
    try {
      await persistIdentity(remember ? next : null, attempt);
      if (attempt === generation) remembered = remember;
    } catch {
      if (remember) throw new Error("Paired for this session, but this browser could not save the device. Continue without remembering it.");
    }
  } finally { pairing.close(); }
}
export async function forgetBrowser(): Promise<void> {
  generation++; const forgottenGeneration = generation; link?.close(); link = null; identity = null; remembered = false;
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs.clear();
  try { localStorage.removeItem("shahi.pins"); } catch { /* Storage can be disabled. */ }
  try { await persistIdentity(null, generation); } catch { /* Memory-only sessions have no database. */ }
  if (generation !== forgottenGeneration) return;
  const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
  const subscription = await registration?.pushManager?.getSubscription().catch(() => null);
  if (generation === forgottenGeneration) await subscription?.unsubscribe().catch(() => {});
}
export function keepBlob(blob: Blob): string { const url = URL.createObjectURL(blob); blobs.add(url); return url; }
export function releaseBlob(url: string): void { if (blobs.delete(url)) URL.revokeObjectURL(url); }
