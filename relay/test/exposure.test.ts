import { expect, test } from "bun:test";

test("production relay and site expose only their owned hostnames", async () => {
  for (const path of ["../wrangler.toml", "../../site/wrangler.toml"]) {
    const config = Bun.TOML.parse(await Bun.file(new URL(path, import.meta.url)).text()) as {
      workers_dev: boolean; preview_urls: boolean; routes: { pattern: string; custom_domain: boolean }[];
    };
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes.every((route) => route.custom_domain && /(^|\.)getshahi\.dev$/.test(route.pattern))).toBe(true);
  }
});
