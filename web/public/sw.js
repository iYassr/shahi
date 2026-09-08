/* Only public app assets belong in this cache. Never cache requests containing
 * credentials, query parameters, API data or arbitrary navigation responses. */
const BASE = new URL(self.registration.scope).pathname;
const PREFIX = `shahi-shell:${BASE}:`;
const CACHE = `${PREFIX}v7`;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icon-192.png`, `${BASE}icon-180.png`, `${BASE}welcome.js`];
const assetPath = (path) => path.startsWith(`${BASE}assets/`);
const appPath = (path) => path === BASE || path === `${BASE}index.html` ||
  path === `${BASE}settings` || path === `${BASE}spaces` ||
  path.startsWith(`${BASE}space/`) || path.startsWith(`${BASE}pane/`);

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

async function precache() {
  try {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const response = await fetch(BASE, { cache: "reload", credentials: "omit" });
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^" ]+)"/g)]
      .map((match) => new URL(match[1], self.registration.scope))
      .filter((url) => url.origin === self.location.origin && !url.search && assetPath(url.pathname))
      .map((url) => url.href);
    await cache.addAll(assets);
  } catch { /* Offline installation can still use the runtime cache. */ }
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Never delete another app's caches on the marketing website's origin.
    await Promise.all(names.filter((name) => (name.startsWith(PREFIX) ||
      (BASE === "/" && /^shahi-shell-v\d+$/.test(name))) && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search ||
      request.headers.has("authorization") || request.headers.has("x-shahi-api")) return;
  if (assetPath(url.pathname) || url.pathname === `${BASE}welcome.js`) event.respondWith(cacheFirst(request));
  else if (request.mode === "navigate" && appPath(url.pathname)) event.respondWith(shellFirst(event));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && !response.redirected) await cache.put(request, response.clone());
  return response;
}

async function shellFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(BASE);
  // A normal launch is local. Explicit reloads must reach the network so the
  // foreground bundle checker can replace an old release without a reload loop.
  // Fetch the canonical public shell, never a URL supplied in session data.
  const fresh = fetch(BASE, { cache: "no-cache", credentials: "omit" }).then(async (response) => {
    if (response.ok && !response.redirected && response.headers.get("content-type")?.includes("text/html")) {
      const html = await response.clone().text();
      const assets = [...html.matchAll(/(?:src|href)="([^" ]+)"/g)]
        .map((match) => new URL(match[1], self.registration.scope))
        .filter((url) => url.origin === self.location.origin && !url.search && assetPath(url.pathname));
      // Save the new shell only after its entry assets are available offline.
      await Promise.all(assets.map(async (url) => {
        const asset = await cacheFirst(new Request(url.href, { credentials: "omit" }));
        if (!asset.ok || asset.redirected) throw new Error("App asset unavailable");
      }));
      await cache.put(BASE, response.clone());
      return response;
    }
    return undefined;
  }).catch(() => undefined);
  event.waitUntil(fresh);
  if (hit && request.cache !== "reload" && request.cache !== "no-cache") return hit;
  const raced = await Promise.race([fresh, new Promise((resolve) => setTimeout(resolve, 1500))]);
  return raced ?? hit ?? await fresh ?? new Response("offline", { status: 503 });
}

self.addEventListener("push", (event) => {
  let payload = { title: "Shahi", body: "An agent needs you.", paneId: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A malformed payload should still surface a notification; iOS revokes the
    // push permission of a worker that receives a push and shows nothing.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: `${BASE}icon-192.png`,
      badge: `${BASE}icon-192.png`,
      // Re-notifying the same pane replaces its notification rather than
      // stacking a new one on top.
      tag: `${payload.serverId || ""}:${payload.paneId || "herdr"}`,
      renotify: Boolean(payload.paneId),
      data: { paneId: payload.paneId, serverId: payload.serverId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const paneId = event.notification.data?.paneId;
  const serverId = event.notification.data?.serverId;
  const target = paneId ? `${BASE}notification?pane=${encodeURIComponent(paneId)}&computer=${encodeURIComponent(serverId || "")}` : BASE;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer an already-open app: focus it and route, rather than opening a
      // second copy.
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
