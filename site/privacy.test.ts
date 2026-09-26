import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// REVIEW_EXPIRES_AT is what the demo Worker enforces; everything below repeats
// it in words for people. It moved from 19 October to 31 December in 45431eb
// and only the operations notes followed, so the privacy policy published from
// 0dd970a understated how long review data is kept, and nothing noticed
// (pre-release bug hunt, B101). The words were corrected by hand in c17d65e;
// this is what notices the next time. The demo's own page is in the list
// because it is text in the container image, not a value the Worker passes.
test("every statement of when the review environment expires names the date it is configured to expire", () => {
  const { vars } = Bun.TOML.parse(read("demo/wrangler.toml")) as { vars: { REVIEW_EXPIRES_AT: string } };
  const configured = new Date(vars.REVIEW_EXPIRES_AT).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  for (const path of ["site/public/privacy.html", "docs/privacy-policy.md", "docs/app-review-privacy.md", "demo/README.md", "demo/container/controller.ts"]) {
    const stated = [...read(path).replace(/\s+/g, " ").matchAll(/expires (?:on )?(\d{1,2} [A-Z][a-z]+ \d{4})/g)].map((match) => match[1]);
    expect(stated.length, path).toBeGreaterThan(0);
    for (const date of stated) expect(date, path).toBe(configured);
  }
});
