import { reconcileArray } from "@/lib/session";

const key = (p: { id: string }) => p.id;

describe("reconcileArray", () => {
  // The crash this locks down: a snapshot with MORE items than the last one
  // used to index `prev[i]` out of bounds and call the key function on
  // undefined — "Cannot read property 'paneId' of undefined".
  test("does not throw when the next array is longer than prev", () => {
    const prev = [{ id: "a" }];
    const next = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(() => reconcileArray(prev, next, key)).not.toThrow();
    expect(reconcileArray(prev, next, key).map(key)).toEqual(["a", "b", "c"]);
  });

  test("reuses the object identity of an unchanged entry", () => {
    const a = { id: "a", n: 1 };
    const out = reconcileArray([a], [{ id: "a", n: 1 }], (p) => p.id);
    expect(out[0]).toBe(a);
  });

  test("returns the previous array unchanged when nothing moved", () => {
    const prev = [{ id: "a" }, { id: "b" }];
    const out = reconcileArray(prev, [{ id: "a" }, { id: "b" }], key);
    expect(out).toBe(prev);
  });

  test("takes the fresh value when an entry's content changed", () => {
    const a = { id: "a", n: 1 };
    const out = reconcileArray([a], [{ id: "a", n: 2 }], (p) => p.id);
    expect(out[0]).not.toBe(a);
    expect(out[0]!.n).toBe(2);
  });

  test("handles removal without indexing out of bounds", () => {
    const prev = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reconcileArray(prev, [{ id: "b" }], key).map(key)).toEqual(["b"]);
  });
});
