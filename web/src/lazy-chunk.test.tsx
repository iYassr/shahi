import { afterEach, beforeEach, expect, test } from "bun:test";
import { Suspense } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { lazyChunk } from "./lazy-chunk";
import { UPDATE_AVAILABLE } from "./version";

/**
 * A page left open across a deploy asks for a terminal or PDF chunk the server
 * no longer has. That used to reject a `React.lazy`, which stays rejected, and
 * the error boundary replaced the whole app.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
let offers: number;
let deployed: string | null;
const restore: Array<() => void> = [];
function replace(key: string, value: unknown) {
  const had = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  restore.push(() => { if (had) Object.defineProperty(globalThis, key, had); else Reflect.deleteProperty(globalThis, key); });
}

beforeEach(() => {
  offers = 0;
  deployed = "/assets/index-next.js";
  const events = new EventTarget();
  events.addEventListener(UPDATE_AVAILABLE, () => offers++);
  replace("window", events);
  // The page runs the old bundle; the server's shell names whatever `deployed` is.
  replace("document", { querySelectorAll: () => [{ src: "https://computer.example/assets/index-running.js" }] });
  replace("fetch", async () => deployed === null ? Promise.reject(new TypeError("offline")) : new Response(`<script type="module" src="${deployed}"></script>`));
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  while (restore.length) restore.pop()!();
});

const output = () => JSON.stringify(view!.toJSON());
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

test("a chunk removed by a newer release shows a notice in its place and offers the update, instead of breaking the app", async () => {
  let available = false;
  const Terminal = lazyChunk(() => available
    ? Promise.resolve({ default: () => <p>terminal drawn</p> })
    : Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  await act(async () => {
    view = create(<div><p>conversation</p><Suspense fallback={<p>loading</p>}><Terminal /></Suspense></div>);
  });
  await settle();
  // The rest of the screen is still there; only the part that failed says so.
  expect(output()).toContain("conversation");
  expect(output()).toContain("could not be loaded");
  expect(offers).toBe(1);

  // A dropped connection rather than a deploy: trying again loads it.
  available = true;
  const retry = view!.root.findAllByType("button").find((button) => button.children.join("") === "Try again")!;
  await act(async () => retry.props.onClick());
  await settle();
  expect(output()).toContain("terminal drawn");
});

test("a chunk that fails while the server still serves this release does not claim an update", async () => {
  deployed = "/assets/index-running.js";
  const Pdf = lazyChunk(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  await act(async () => { view = create(<Suspense fallback={null}><Pdf /></Suspense>); });
  await settle();
  expect(output()).toContain("could not be loaded");
  expect(offers).toBe(0);

  // Offline: nothing to compare against, and still no false offer.
  deployed = null;
  await act(async () => view!.root.findAllByType("button")[0]!.props.onClick());
  await settle();
  expect(output()).toContain("could not be loaded");
  expect(offers).toBe(0);
});
