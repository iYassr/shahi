import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { serviceWorkerRelease, stampServiceWorker, type ReleaseFile } from "../sw-build";

/**
 * The service worker, run as a browser would run it: the stamped source in a
 * context of its own, against a Cache Storage and a network faked in memory.
 */
const template = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const text = (value: string) => new TextEncoder().encode(value);
const release = (files: Record<string, string>): ReleaseFile[] => Object.entries(files).map(([path, body]) => ({ path, bytes: text(body) }));
const releaseOf = (source: string) => /const RELEASE = "([^"]+)";/.exec(source)![1]!;
const SHELL = (bundle: string) => `<!doctype html><script type="module" src="/pwa/assets/${bundle}"></script>`;
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const script = (body: string) => new Response(body, { headers: { "content-type": "text/javascript" } });

type Route = (url: URL) => Response | Promise<Response> | undefined;
function worker(source: string, network: Route, options: { timers?: "immediate" | "real"; windows?: unknown[] } = {}) {
  const storage = new Map<string, Map<string, Response>>();
  const origin = "https://getshahi.dev";
  const key = (request: string | Request) => new URL(typeof request === "string" ? request : request.url, `${origin}/pwa/sw.js`).href;
  const cacheFor = (name: string) => {
    if (!storage.has(name)) storage.set(name, new Map());
    const entries = storage.get(name)!;
    return {
      match: async (request: string | Request) => entries.get(key(request))?.clone(),
      put: async (request: string | Request, response: Response) => { entries.set(key(request), response.clone()); },
    };
  };
  const listeners: Record<string, (event: any) => void> = {};
  const fetched: string[] = [];
  const opened: string[] = [];
  runInNewContext(source, {
    URL, Request, Response, Headers, MessageChannel, Promise,
    setTimeout: options.timers === "real" ? setTimeout : (fn: () => void) => { queueMicrotask(fn); return 0; },
    clearTimeout,
    self: {
      registration: { scope: `${origin}/pwa/` },
      location: { origin },
      addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => options.windows ?? [], openWindow: async (url: string) => { opened.push(url); } },
    },
    caches: {
      keys: async () => [...storage.keys()],
      open: async (name: string) => cacheFor(name),
      delete: async (name: string) => storage.delete(name),
    },
    fetch: async (request: string | Request) => {
      const url = new URL(key(request));
      fetched.push(url.pathname);
      return (await network(url)) ?? new Response("not found", { status: 404 });
    },
  });
  async function extend(type: string, event: object = {}) {
    const pending: Promise<unknown>[] = [];
    listeners[type]!({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  /** What the page receives; work the worker continues afterwards is not awaited. */
  async function request(path: string, init: { mode?: string; cache?: string } = {}) {
    let response: Promise<Response> | undefined;
    listeners.fetch!({
      request: { url: `${origin}${path}`, method: "GET", mode: init.mode ?? "cors", cache: init.cache ?? "default", headers: new Headers() },
      respondWith: (value: Promise<Response>) => { response = value; },
      waitUntil: () => {},
    });
    return response;
  }
  return { storage, fetched, opened, extend, request, names: () => [...storage.keys()], has: (name: string, path: string) => storage.get(name)?.has(`${origin}${path}`) ?? false };
}

describe("a release names its own cache", () => {
  const files = { "index.html": SHELL("index-a.js"), "assets/index-a.js": "app", "assets/Terminal-a.js": "terminal", "welcome.js": "hello", "manifest.webmanifest": "{}" };

  test("changing an unhashed public file changes the release, so installed apps replace their cache", () => {
    const before = stampServiceWorker(template, release(files));
    const after = stampServiceWorker(template, release({ ...files, "welcome.js": "hello again" }));
    // welcome.js and the manifest were edited twice without anyone bumping the
    // hand-written cache name, and installed apps kept the old copies.
    expect(releaseOf(before)).not.toBe(releaseOf(after));
    expect(releaseOf(before)).toBe(releaseOf(stampServiceWorker(template, release(files))));
    expect(before).toContain('const FILES = ["assets/Terminal-a.js","assets/index-a.js","manifest.webmanifest","welcome.js"];');
  });

  test("a worker that lost its release lines fails the build rather than shipping one cache for ever", () => {
    expect(() => stampServiceWorker(template.replace(/^const RELEASE = .*$/m, 'const CACHE_NAME = "v9";'), release(files))).toThrow("RELEASE");
  });

  test("the build stamps the worker it writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shahi-sw-"));
    try {
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "sw.js"), template);
      await writeFile(join(dir, "assets", "Terminal-a.js"), "terminal");
      await writeFile(join(dir, "icon-192.png"), "png");
      const plugin = serviceWorkerRelease() as { writeBundle: (options: { dir: string }) => Promise<void> };
      await plugin.writeBundle({ dir });
      const stamped = await readFile(join(dir, "sw.js"), "utf8");
      expect(releaseOf(stamped)).toMatch(/^[0-9a-f]{16}$/);
      expect(stamped).toContain('const FILES = ["assets/Terminal-a.js","icon-192.png"];');
      const config = (await import("../vite.config")).default as unknown as (env: { mode: string; command: string }) => { plugins: Array<{ name?: string }> };
      expect(config({ mode: "hosted", command: "build" }).plugins.flat().map((plugin) => plugin?.name)).toContain("shahi:service-worker-release");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("the worker keeps a release openable", () => {
  const releaseA = stampServiceWorker(template, release({ "index.html": SHELL("index-a.js"), "assets/index-a.js": "app a", "assets/Terminal-a.js": "terminal a", "welcome.js": "hello" }));
  const releaseB = stampServiceWorker(template, release({ "index.html": SHELL("index-b.js"), "assets/index-b.js": "app b", "assets/Terminal-b.js": "terminal b", "welcome.js": "hello" }));
  const cacheA = `shahi-shell:/pwa/:${releaseOf(releaseA)}`;
  const cacheB = `shahi-shell:/pwa/:${releaseOf(releaseB)}`;
  const serveA: Route = (url) => url.pathname === "/pwa/" ? html(SHELL("index-a.js")) : url.pathname.endsWith(".js") ? script(url.pathname) : undefined;
  const serveB: Route = (url) => url.pathname === "/pwa/" ? html(SHELL("index-b.js")) : /-b\.js$|welcome\.js$/.test(url.pathname) ? script(url.pathname) : undefined;

  test("installing a release caches every file it ships, the lazily loaded terminal included", async () => {
    const sw = worker(releaseA, serveA);
    await sw.extend("install");
    expect(sw.has(cacheA, "/pwa/assets/Terminal-a.js")).toBe(true);
    expect(sw.has(cacheA, "/pwa/welcome.js")).toBe(true);
    expect(sw.has(cacheA, "/pwa/")).toBe(true);
  });

  test("an install that cannot fetch every file of its release fails and stores nothing", async () => {
    const sw = worker(releaseB, (url) => url.pathname.endsWith("/Terminal-b.js") ? undefined : serveB(url));
    await expect(sw.extend("install")).rejects.toThrow("App file unavailable");
    // The previous worker stays in charge, with its own complete cache.
    expect(sw.names()).toEqual([]);
  });

  test("a page left open on the previous release still opens its terminal after the next release takes over", async () => {
    const first = worker(releaseA, serveA);
    await first.extend("install");
    // The deploy: release A's chunks are gone from the server.
    const next = worker(releaseB, serveB);
    for (const [name, entries] of first.storage) next.storage.set(name, entries);
    await next.extend("install");
    await next.extend("activate");
    expect(next.names()).toEqual([cacheA, cacheB]);
    const terminal = await next.request("/pwa/assets/Terminal-a.js");
    expect(await terminal!.text()).toBe("/pwa/assets/Terminal-a.js");
    expect(next.fetched).not.toContain("/pwa/assets/Terminal-a.js");
  });

  test("activation keeps one earlier complete release and removes anything older, broken or another app's", async () => {
    const sw = worker(releaseB, serveB);
    // A cache holding the shell is a complete release; an interrupted install never stored one.
    const complete = (name: string) => sw.storage.set(name, new Map([["https://getshahi.dev/pwa/", html("shell")]]));
    complete("shahi-shell:/pwa/:v8");
    complete(cacheA);
    sw.storage.set("shahi-shell:/pwa/:interrupted-install", new Map());
    sw.storage.set("another-app", new Map());
    await sw.extend("install");
    await sw.extend("activate");
    expect(sw.names()).toEqual([cacheA, "another-app", cacheB]);
  });

  test("a computer's HTML answer for a missing chunk is never stored as the chunk", async () => {
    const sw = worker(releaseB, (url) => url.pathname === "/pwa/assets/Terminal-gone.js" ? html("<!doctype html>") : serveB(url));
    await sw.extend("install");
    await sw.request("/pwa/assets/Terminal-gone.js");
    expect(sw.has(cacheB, "/pwa/assets/Terminal-gone.js")).toBe(false);
  });

  test("a normal launch reaches the network first, so a deploy appears on the next launch", async () => {
    const sw = worker(releaseA, serveA, { timers: "real" });
    await sw.extend("install");
    const launched = worker(releaseA, serveB, { timers: "real" });
    for (const [name, entries] of sw.storage) launched.storage.set(name, entries);
    const response = await launched.request("/pwa/pane/w1%3Ap1", { mode: "navigate" });
    expect(await response!.text()).toBe(SHELL("index-b.js"));
  });

  test("a launch with the network stalled still opens from the cache", async () => {
    const sw = worker(releaseA, serveA);
    await sw.extend("install");
    const stalled = worker(releaseA, () => new Promise<Response>(() => {}));
    for (const [name, entries] of sw.storage) stalled.storage.set(name, entries);
    const response = await stalled.request("/pwa/", { mode: "navigate" });
    expect(await response!.text()).toBe(SHELL("index-a.js"));
  });
});
