/*
 * Service worker.
 *
 * Its only real job is Web Push: on iOS, notifications are delivered to a
 * service worker in an installed PWA, and nowhere else. Deliberately no
 * offline caching — a cached dashboard would show stale agent states, which is
 * worse than showing nothing, and this app is useless without its server
 * anyway.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = { title: "herdr", body: "An agent needs you.", paneId: "" };
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
