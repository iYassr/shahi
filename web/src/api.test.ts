import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApi } from "./api";

/*
 * The locally served app's multipart upload, against a fetch that answers only
 * when it is told to — or aborted. Nothing here reaches a network.
 */
let seen: AbortSignal | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  seen = undefined;
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    fetch: (_path: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
});

// Cancel upload aborted nothing here: the request ran to the end and the file
// was attached anyway (pre-release bug hunt).
test("cancelling a direct upload ends its request and says it was cancelled", async () => {
  const cancel = new AbortController();
  const upload = createApi().upload(new File(["photo"], "photo.png", { type: "image/png" }), { signal: cancel.signal });
  await Bun.sleep(0);
  // The cancel joins the upload's deadline rather than replacing it.
  expect(seen).toBeDefined();
  expect(seen).not.toBe(cancel.signal);
  cancel.abort();
  await expect(upload).rejects.toThrow("Upload cancelled");
});
