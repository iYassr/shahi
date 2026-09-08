import { SHAHI_API_VERSION, type Session, type PairingPayload } from "@shahi/shared";
import { RelayLink, deviceTarget, pairingTarget, type RelayIdentity } from "@shahi/shared/relay-client";
import { parsePairingUrl } from "@shahi/shared/pairing";

export const hosted = import.meta.env?.BASE_URL === "/pwa/";
let identity: RelayIdentity | null = null;
let link: RelayLink | null = null;
const live = new Map<string, { link: RelayLink; identity: RelayIdentity; session: Session | null }>();
const notifyComputers = () => window.dispatchEvent(new Event("shahi:computers-updated"));
let remembered = false;
let generation = 0;
const blobs = new Set<string>();
const DB = "shahi-browser-device";
interface Computer { identity: RelayIdentity; name: string; remembered: boolean }
let computers: Computer[] = [];
let restoredComputers: Computer[] = [];
export function browserComputers() {
  return computers.map(({ identity: item, name, remembered }) => ({ id: item.serverId, name, remembered, address: new URL(item.relay).host, state: live.get(item.serverId)?.link.state ?? "lost" }));
}
function rememberComputer(next: RelayIdentity, saved: boolean) {
  const previous = computers.find(c => c.identity.serverId === next.serverId);
  computers = [...computers.filter(c => c.identity.serverId !== next.serverId),
    { identity: next, remembered: saved, name: previous?.name ?? `${new URL(next.relay).host} · ${next.serverId.slice(0, 8)}` }];
}


function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("This browser could not save the device. Use a private session instead."));
  });
}
async function savedIdentity(value?: RelayIdentity | null, savedComputers: Computer[] = []): Promise<RelayIdentity | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("identity", value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("identity");
      const request = value === undefined ? store.get("current") : value === null ? store.delete("current") : store.put(value, "current");
      const saved = value === undefined ? store.get("computers") : store.put(savedComputers, "computers");
      tx.oncomplete = () => {
        if (value === undefined) restoredComputers = saved.result ?? [];
        resolve(value === undefined ? request.result ?? null : value);
      };
      tx.onerror = () => reject(new Error("Could not update this browser's saved pairing."));
      tx.onabort = tx.onerror;
    });
  } finally { db.close(); }
}

// Serialize persistence with removal: a late pairing write must never resurrect
// credentials after logout, revocation, or a newer pairing attempt.
let credentialWrites: Promise<unknown> = Promise.resolve();
function persistIdentity(value: RelayIdentity | null, expectedGeneration: number): Promise<void> {
  const saved = computers.filter(c => c.remembered);
  const operation = credentialWrites.then(async () => {
    if (expectedGeneration === generation) await savedIdentity(value, saved);
  });
  credentialWrites = operation.catch(() => {});
  return operation;
}

function persistComputerNames(): void {
  const saved = computers.filter(c => c.remembered).map(c => ({ ...c }));
  credentialWrites = credentialWrites.catch(() => {}).then(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("identity", "readwrite");
        tx.objectStore("identity").put(saved, "computers");
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = tx.onerror;
      });
    } finally { db.close(); }
  }).catch(() => {});
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
function ensureComputer(next: RelayIdentity) {
  const known = live.get(next.serverId);
  if (known && known.identity.deviceId === next.deviceId && known.identity.deviceSecret === next.deviceSecret) return known;
  known?.link.close();
  const entry = { identity: next, link: new RelayLink(deviceTarget(next)), session: null as Session | null };
  live.set(next.serverId, entry);
  entry.link.subscribe({
    onMessage(message) {
      if (live.get(next.serverId) !== entry || message.type !== "session") return;
      entry.session = message.session;
      const computer = computers.find(c => c.identity.serverId === next.serverId);
      if (computer && message.session.serverName && computer.name !== message.session.serverName) {
        computer.name = message.session.serverName;
        if (computer.remembered) persistComputerNames();
        notifyComputers();
      }
    },
    onLink() { notifyComputers(); },
    onExpired: () => {
      if (live.get(next.serverId) !== entry) return;
      const wasSelected = identity?.serverId === next.serverId;
      void forgetBrowser(next.serverId).then(() => { if (wasSelected && !identity) window.dispatchEvent(new Event("shahi:unauthorized")); });
    },
  });
  entry.link.ensureConnected();
  return entry;
}
function activate(next: RelayIdentity): void {
  link?.watch(null);
  identity = next; link = ensureComputer(next).link;
}
if (typeof window !== "undefined") {
  const reconnectAll = () => { for (const entry of live.values()) entry.link.ensureConnected(); };
  window.addEventListener("online", reconnectAll);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reconnectAll(); });
}
let restoration: Promise<void> | undefined;
export function restoreBrowser(): Promise<void> {
  return restoration ??= (async () => {
    if (!hosted) return;
    const before = generation;
    try {
      const saved = await savedIdentity();
      if (before !== generation) return;
      computers = restoredComputers;
      for (const computer of computers) ensureComputer(computer.identity);
      if (saved) {
        readPairing(`shahi://pair#v=1&server=${encodeURIComponent(saved.serverId)}&relay=${encodeURIComponent(saved.relay)}&secret=${encodeURIComponent(saved.deviceSecret)}`);
        if (typeof saved.deviceId !== "string" || !saved.deviceId) return;
        rememberComputer(saved, true); activate(saved); remembered = true;
      }
    } catch { /* Storage may be unavailable in private mode; pairing still works in memory. */ }
  })();
}
export function browserConnection() { return { identity, remembered, link, generation, session: identity ? live.get(identity.serverId)?.session ?? null : null }; }
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
    rememberComputer(next, remember); activate(next); remembered = false;
    try {
      await persistIdentity(remember ? next : null, attempt);
      if (attempt === generation) remembered = remember;
    } catch {
      rememberComputer(next, false);
      if (remember) throw new Error("Paired for this session, but this browser could not save the device. Continue without remembering it.");
    }
  } finally { pairing.close(); }
}
export async function forgetBrowser(id = identity?.serverId): Promise<void> {
  const selected = id === identity?.serverId;
  computers = computers.filter(c => c.identity.serverId !== id);
  live.get(id ?? "")?.link.close(); live.delete(id ?? "");
  if (selected) { generation++; link = null; identity = null; remembered = false; }
  const forgottenGeneration = generation;
  notifyComputers();
  if (selected) { for (const url of blobs) URL.revokeObjectURL(url); blobs.clear(); }
  try { localStorage.removeItem(`shahi.pins.${id}`); localStorage.removeItem(`shahi.push.dismissed.${id}`); } catch { /* Storage can be disabled. */ }
  try { await persistIdentity(remembered ? identity : null, generation); } catch { /* Memory-only sessions have no database. */ }
  if (generation !== forgottenGeneration) return;
  if (computers.some(c => c.remembered)) return;
  const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
  const subscription = await registration?.pushManager?.getSubscription().catch(() => null);
  if (generation === forgottenGeneration) await subscription?.unsubscribe().catch(() => {});
}
export function keepBlob(blob: Blob): string { const url = URL.createObjectURL(blob); blobs.add(url); return url; }
export function releaseBlob(url: string): void { if (blobs.delete(url)) URL.revokeObjectURL(url); }

/** Switching preserves every device grant; only explicit sign-out removes one. */
export async function selectBrowserComputer(id: string | null): Promise<void> {
  const target = id === null ? undefined : computers.find(c => c.identity.serverId === id);
  if (id !== null && !target) throw new Error("That computer is no longer saved. Pair it again.");
  const before = generation;
  try { await persistIdentity(target?.remembered ? target.identity : null, before); }
  catch (error) {
    // Private sessions must still be switchable when IndexedDB is disabled.
    if (computers.some(c => c.remembered)) throw error;
  }
  if (generation !== before) return;
  generation++;
  link?.watch(null); link = null; identity = null; remembered = false;
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs.clear();
  if (target) { activate(target.identity); remembered = target.remembered; }
  window.dispatchEvent(new CustomEvent("shahi:computer-changed", { detail: { pairing: id === null } }));
}
export function nameBrowserComputer(name: string): void {
  const current = computers.find(c => c.identity === identity);
  if (!current || !name || current.name === name) return;
  current.name = name;
  if (current.remembered) persistComputerNames();
}

export async function revokeBrowserComputer(id: string): Promise<void> {
  const computer = computers.find(c => c.identity.serverId === id);
  if (!computer) return;
  const entry = ensureComputer(computer.identity);
  const wasSelected = identity?.serverId === id;
  try {
    const res = await entry.link.request({ method: "DELETE", path: `/api/devices/${encodeURIComponent(computer.identity.deviceId)}`, headers: { "x-shahi-api": String(SHAHI_API_VERSION) }, body: null }, 15000);
    if (!res.ok) throw new Error("Could not revoke access. Try again when the computer is online.");
  } catch (e) { if (live.has(id)) throw e; }
  await forgetBrowser(id);
  if (wasSelected && !identity) window.dispatchEvent(new Event("shahi:unauthorized"));
}
