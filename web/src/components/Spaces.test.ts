import { describe, expect, test } from "bun:test";
import { fromTheLeft } from "./Spaces";

/**
 * Paths lose their head, not their tail.
 *
 * Done in JS because the CSS way — `direction: rtl` — puts the ellipsis in the
 * right place and the segments in the wrong order: `~/MediaProduction/test`
 * renders as `MediaProduction/test/~`. That shipped once already.
 */
describe("fromTheLeft", () => {
  test("leaves a short path alone", () => {
    expect(fromTheLeft("~/pc")).toBe("~/pc");
  });

  test("drops the head of a long one", () => {
    const short = fromTheLeft("~/work/clients/acme/site/packages/web");
    expect(short.startsWith("…")).toBe(true);
    expect(short.endsWith("/web")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(31);
  });

  test("keeps what distinguishes two similar paths", () => {
    const a = fromTheLeft("~/work/clients/acme/site/packages/web");
    const b = fromTheLeft("~/work/clients/beta/site/packages/api");
    expect(a).not.toBe(b);
  });

  test("starts at a segment boundary rather than mid-word", () => {
    expect(fromTheLeft("~/Documents/Projects/SecurityProgram/mappings")).toMatch(/^…\//);
  });

  test("never reorders anything", () => {
    // The bug this replaces: segments arriving backwards.
    expect(fromTheLeft("~/MediaProduction/test")).toBe("~/MediaProduction/test");
  });
});
