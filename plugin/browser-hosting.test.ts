import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/public/sw.js", import.meta.url), "utf8");
function worker(base = "/pwa/") {
  const listeners: Record<string, (event: any) => void> = {};
  const deleted: string[] = [];
  const fetched: string[] = [];
  runInNewContext(source, {
    URL, Response, setTimeout: (fn: () => void) => { fn(); },
    self: {
      registration: { scope: `https://getshahi.dev${base}` },
      location: { origin: "https://getshahi.dev" },
      addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
      clients: { claim: async () => {} },
    },
    caches: {
      keys: async () => ["another-app", "shahi-shell:/pwa/:old", "shahi-shell:/:old", "shahi-shell-v4"],
      delete: async (key: string) => { deleted.push(key); },
      open: async () => ({ match: async () => new Response("shell"), put: async () => {} }),
    },
    fetch: async (url: string) => { fetched.push(url); return new Response("shell", { headers: { "content-type": "text/html" } }); },
  });
  return { listeners, deleted, fetched };
}

describe("hosted browser cache boundary", () => {
  test("never intercepts API, queries, authenticated requests or another app", () => {
    const { listeners } = worker();
    for (const path of ["/api/session", "/pwa/api/session", "/pwa/files/foo", "/privacy", "/pwa/?secret=abc", "/pwa/assets/app.js?token=abc", "https://relay.example/api/session"]) {
      let intercepted = false;
      listeners.fetch!({ request: new Request(new URL(path, "https://getshahi.dev").href), respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
    for (const header of ["authorization", "x-shahi-api"]) {
      let intercepted = false;
      listeners.fetch!({ request: new Request("https://getshahi.dev/pwa/assets/app.js", { headers: { [header]: "secret" } }), respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });

  test("navigation fetches only the canonical public shell", async () => {
    const { listeners, fetched } = worker();
    let response: Promise<Response> | undefined;
    listeners.fetch!({ request: { url: "https://getshahi.dev/pwa/pane/private-pane-id", method: "GET", mode: "navigate", headers: new Headers() }, respondWith: (promise: Promise<Response>) => { response = promise; } });
    expect(await (await response!).text()).toBe("shell");
    expect(fetched).toEqual(["/pwa/"]);
  });

  test("activation removes only this app's old cache", async () => {
    const { listeners, deleted } = worker();
    let done: Promise<void> | undefined;
    listeners.activate!({ waitUntil: (promise: Promise<void>) => { done = promise; } });
    await done;
    expect(deleted).toEqual(["shahi-shell:/pwa/:old"]);
  });

  test("manifest scope is relative, so hosted and sidecar builds stay contained", () => {
    const manifest = JSON.parse(readFileSync(new URL("../web/public/manifest.webmanifest", import.meta.url), "utf8"));
    expect(manifest.scope).toBe("./");
    expect(manifest.start_url).toBe("./");
    expect(new URL(manifest.scope, "https://getshahi.dev/pwa/manifest.webmanifest").pathname).toBe("/pwa/");
  });
});
