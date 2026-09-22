import { describe, expect, test } from "bun:test";
import { bundles } from "./version";
import { clearWebDrafts, draftOwner, webDraft } from "./drafts";

/**
 * The comparison behind "am I running the current build?".
 *
 * Worth its own test because getting it wrong is either a reload loop or a
 * phone that quietly runs last week's code — and the second one is invisible,
 * which is how it went unnoticed.
 */
describe("deployed", () => {
  const html = (script: string) =>
    `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script>` +
    `<link rel="stylesheet" href="/assets/index-abc.css"></head><body></body></html>`;

  test("finds the bundle the shell points at", () => {
    expect(bundles.deployed(html("/assets/index-Drzbb5-Y.js"))).toBe("/assets/index-Drzbb5-Y.js");
  });

  test("is not confused by the stylesheet beside it", () => {
    expect(bundles.deployed(html("/assets/index-x.js"))).not.toContain(".css");
  });

  test("finds nothing in a page with no bundle", () => {
    expect(bundles.deployed("<!doctype html><html><body>nope</body></html>")).toBeNull();
  });

  test("hashed names are what makes the comparison meaningful", () => {
    // Same build, same name; a rebuild changes the hash, which is the signal.
    const a = bundles.deployed(html("/assets/index-AAA.js"));
    const b = bundles.deployed(html("/assets/index-BBB.js"));
    expect(a).not.toBe(b);
  });
});

test("finds a hosted /pwa bundle and ignores non-script asset references", () => {
  expect(bundles.deployed('<script type="module" src="/pwa/assets/index-next.js"></script>')).toBe("/pwa/assets/index-next.js");
  expect(bundles.deployed('<img src="/pwa/assets/index-next.js">')).toBeNull();
});

test("a deployed update preserves memory-only access and offers explicit reload", async () => {
  const { reloadIfStale } = await import("./version");
  const keys = ["document", "location", "fetch"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  let reloads = 0;
  let offers = 0;
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => [{ src: "https://getshahi.dev/pwa/assets/index-old.js" }] } });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { reload: () => reloads++ } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => new Response('<script src="/pwa/assets/index-new.js"></script>') });
    expect(await reloadIfStale(() => 100_000, { canReload: () => false, onAvailable: () => offers++ })).toBe(false);
    expect(reloads).toBe(0);
    expect(offers).toBe(1);
    expect(await reloadIfStale(() => 200_000, { canReload: () => true })).toBe(true);
    expect(reloads).toBe(1);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

test("an update waits for a draft or uncertain send in a conversation that is no longer open", async () => {
  const { hasPendingWork } = await import("./version");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  // Nothing on screen marks pending work: the pane holding it was navigated away from.
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
  const owner = draftOwner({ serverId: "computer", deviceId: "browser" });
  try {
    expect(hasPendingWork()).toBe(false);
    const draft = webDraft(owner, "w1:p1");
    draft.text = "half-written reply";
    expect(hasPendingWork()).toBe(true);
    draft.text = "";
    draft.attachments = [{ name: "notes.md", path: "/home/me/notes.md" }];
    expect(hasPendingWork()).toBe(true);
    draft.attachments = [];
    // A send whose receipt never arrived: its operation ID must survive for the retry.
    draft.pending = { body: "run the migration", id: "operation-1" };
    expect(hasPendingWork()).toBe(true);
    draft.pending = null;
    draft.inFlight = true;
    expect(hasPendingWork()).toBe(true);
    draft.inFlight = false;
    expect(hasPendingWork()).toBe(false);
  } finally {
    clearWebDrafts(owner);
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
