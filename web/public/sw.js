/* Only public app assets belong in this cache. Private navigation targets can
 * receive the canonical shell, but their URLs and responses are never cached. */

// Stamped by web/sw-build.ts when the app is built: a hash of every file this
// release ships, and their paths. Unbuilt (the dev server) it names nothing.
const RELEASE = "development";
const FILES = [];

const BASE = new URL(self.registration.scope).pathname;
const PREFIX = `shahi-shell:${BASE}:`;
const CACHE = `${PREFIX}${RELEASE}`;
const RELEASED = FILES.map((path) => `${BASE}${path}`);
const assetPath = (path) => path.startsWith(`${BASE}assets/`);
const appPath = (path) => path === BASE || path === `${BASE}index.html` ||
  path === `${BASE}settings` || path === `${BASE}spaces` ||
  path === `${BASE}computers` || path === `${BASE}notification` ||
  path.startsWith(`${BASE}space/`) || path.startsWith(`${BASE}pane/`);
const ours = (name) => name.startsWith(PREFIX) || (BASE === "/" && /^shahi-shell-v\d+$/.test(name));

const isShell = (response) => response.ok && !response.redirected &&
  Boolean(response.headers.get("content-type")?.includes("text/html"));
// A computer's sidecar answers a path it does not have with the app's HTML and
// a 200. Stored under a chunk's name, that would break the chunk for as long
// as the cache lived, so only a real file is ever kept.
const isFile = (response) => response.ok && !response.redirected &&
  !response.headers.get("content-type")?.includes("text/html");

function entryAssets(html) {
  return [...html.matchAll(/(?:src|href)="([^" ]+)"/g)]
    .map((match) => new URL(match[1], self.registration.scope))
    .filter((url) => url.origin === self.location.origin && !url.search && assetPath(url.pathname))
    .map((url) => url.href);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

/**
 * Every file of the release, lazily loaded chunks included.
 *
 * Only the chunks a page had already opened used to be cached, and a deploy
 * removes the old ones from the server — so a page left open across a deploy
 * could not open the terminal or a PDF at all. A failed install leaves the
 * previous worker and its complete cache active.
 */
async function precache() {
  const shell = await fetch(BASE, { cache: "reload", credentials: "omit" });
  if (!isShell(shell)) throw new Error("App shell unavailable");
  const urls = [...new Set([...RELEASED.map((path) => new URL(path, self.registration.scope).href), ...entryAssets(await shell.clone().text())])];
  const files = await Promise.all(urls.map(async (url) => {
    const response = await fetch(url, { cache: "no-cache", credentials: "omit" });
    if (!isFile(response)) throw new Error("App file unavailable");
    return [url, response];
  }));
  // Opened only once every file has arrived, so a failed install leaves no
  // empty cache behind.
  const cache = await caches.open(CACHE);
  await Promise.all(files.map(([url, response]) => cache.put(url, response)));
  // Last, because a cache holding the shell is a complete release.
  await cache.put(BASE, shell);
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Never delete another app's caches on the marketing website's origin.
    const older = (await caches.keys()).filter((name) => ours(name) && name !== CACHE);
    // Keep the newest complete release before this one. A page opened on it is
    // still running it, and asks for chunks by names this release does not
    // have and the server no longer serves. Anything older goes: the cache
    // holds two releases at most. Cache names list in creation order.
    let previous;
    for (const name of [...older].reverse()) {
      if (name.startsWith(PREFIX) && await (await caches.open(name)).match(BASE)) { previous = name; break; }
    }
    await Promise.all(older.filter((name) => name !== previous).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      request.headers.has("authorization") || request.headers.has("x-shahi-api")) return;
  // Notification routing carries pane/computer identifiers. Serve only the
  // canonical shell, never store the queried request or fetch its private URL.
  const notification = request.mode === "navigate" && url.pathname === `${BASE}notification` &&
    [...url.searchParams.keys()].every(key => key === "pane" || key === "computer");
  if (url.search && !notification) return;
  if (assetPath(url.pathname) || RELEASED.includes(url.pathname)) event.respondWith(cacheFirst(request));
  else if (request.mode === "navigate" && appPath(url.pathname)) event.respondWith(shellFirst(event));
});

/** This release's copy first, then the previous release's. */
async function cached(request) {
  const names = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE).reverse();
  for (const name of [CACHE, ...names]) {
    const hit = await (await caches.open(name)).match(request);
    if (hit) return hit;
  }
  return undefined;
}

async function cacheFirst(request) {
  const hit = await cached(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (isFile(response)) await (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

/**
 * Navigations try the network briefly, then fall back to the cached shell.
 *
 * Not cache first: that means every deploy takes two launches to appear — the
 * first shows the old HTML, which names the old bundle — and a page running an
 * old bundle is the one that cannot find its chunks. A second and a half is a
 * long time on a phone's connection and no time at all to a person; offline,
 * the fetch fails at once and the cache answers.
 */
async function shellFirst(event) {
  const cache = await caches.open(CACHE);
  // Fetch the canonical public shell, never a URL supplied in session data.
  const fresh = fetch(BASE, { cache: "no-cache", credentials: "omit" }).then(async (response) => {
    if (!isShell(response)) return undefined;
    // Save the new shell only after its entry assets are available offline.
    await Promise.all(entryAssets(await response.clone().text()).map(async (url) => {
      const asset = await cacheFirst(new Request(url, { credentials: "omit" }));
      if (!isFile(asset)) throw new Error("App asset unavailable");
    }));
    await cache.put(BASE, response.clone());
    return response;
  }).catch(() => undefined);
  event.waitUntil(fresh);
  const raced = await Promise.race([fresh, new Promise((resolve) => setTimeout(resolve, 1500))]);
  return raced ?? await cached(BASE) ?? await fresh ?? new Response("offline", { status: 503 });
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

/**
 * Asks an open page to route itself, and says whether it answered.
 *
 * `WindowClient.navigate` loads a new document: the page reloads, and with it
 * go unsent drafts and computers paired for this session only. The pre-release
 * review found a notification tap discarding exactly those. A page that knows
 * this message routes in place and answers on the port; a page from an older
 * release does not, and is navigated as before.
 */
function routeInPlace(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const settle = (answered) => { clearTimeout(timer); channel.port1.close(); resolve(answered); };
    const timer = setTimeout(() => settle(false), 3000);
    channel.port1.onmessage = () => settle(true);
    client.postMessage(message, [channel.port2]);
  });
}

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
          if (await routeInPlace(client, { type: "shahi:open-notification", pane: paneId || "", computer: serverId || "" })) return;
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
