/*
 * Service worker: Web Push, and the app shell.
 *
 * Push first, because on iOS notifications are delivered to a service worker in
 * an installed PWA and nowhere else.
 *
 * The shell is cached; the data never is. That distinction is the whole policy.
 * An earlier version cached nothing at all, reasoning that a cached dashboard
 * would show stale agents — true, and the reason `/api` and `/ws` are excluded
 * here by name. But the JavaScript, the stylesheet and the HTML are not agent
 * state: they are the same bytes every launch, they carry a content hash in
 * their filenames, and downloading them again is the difference between an app
 * that opens instantly and one that shows a white screen while a phone
 * negotiates TLS.
 */

const CACHE = "shahi-shell-v4";

/** Everything the app needs before it can render anything at all. */
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

/**
 * Caches the shell and whatever build it currently points at.
 *
 * The asset filenames carry content hashes, so they cannot be listed here — but
 * the HTML names them, and it is already being fetched. Without this step the
 * first visit cached the page and not its JavaScript: going offline afterwards
 * produced a blank screen, which is worse than no caching at all.
 */
async function precache() {
  try {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);

    const html = await (await fetch("/", { cache: "reload" })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await cache.addAll(assets);
  } catch {
    // A shell that cannot be prefetched is no reason to refuse to install; the
    // runtime cache fills in from the next request onwards.
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Three rules, in order:
 *
 *  - Anything under `/api` or `/ws` is live state. Never cached, never served
 *    from a cache, not even when offline — a stale agent list is worse than an
 *    honest failure.
 *  - Hashed assets are immutable. Cache first, and never revalidate: a new
 *    build has different filenames.
 *  - Navigations try the network briefly and fall back to the cached shell.
 *    Not the other way around: serving the cache first and refreshing behind it
 *    is the usual advice, but it means every deploy takes two launches to
 *    appear — the first shows the old HTML, which points at the old bundle. A
 *    second and a half is a long time on a tailnet and no time at all to a
 *    person, so the network gets that long before the cache answers.
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(shellFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}

/** How long a navigation waits for the network before the cache answers. */
const NETWORK_GRACE_MS = 1500;

async function shellFirst(request) {
  const cache = await caches.open(CACHE);

  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put("/", response.clone());
      return response;
    })
    .catch(() => undefined);

  const raced = await Promise.race([
    fresh,
    new Promise((resolve) => setTimeout(() => resolve(undefined), NETWORK_GRACE_MS)),
  ]);
  if (raced) return raced;

  // Slow or offline: the cached shell, which is the whole point of having one.
  // The fetch above is still running and will update the cache when it lands.
  return (await cache.match("/")) ?? (await fresh) ?? new Response("offline", { status: 503 });
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
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Re-notifying the same pane replaces its notification rather than
      // stacking a new one on top.
      tag: payload.paneId || "herdr",
      renotify: Boolean(payload.paneId),
      data: { paneId: payload.paneId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const paneId = event.notification.data?.paneId;
  const target = paneId ? `/pane/${encodeURIComponent(paneId)}` : "/";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer an already-open app: focus it and route, rather than opening a
      // second copy.
      for (const client of windows) {
        if (client.url.includes(self.registration.scope)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
