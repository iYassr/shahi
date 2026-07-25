import { describe, expect, test } from "bun:test";
import { bundles } from "./version";

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
