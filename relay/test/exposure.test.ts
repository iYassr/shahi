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

test("operational monitoring has no public route and logs redact request queries", async () => {
  for (const path of ["../wrangler.toml", "../../site/wrangler.toml", "../../operations/wrangler.toml"]) {
    const config = Bun.TOML.parse(await Bun.file(new URL(path, import.meta.url)).text()) as any;
    expect(config.observability.redact_query_string).toBe(true);
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.observability.traces.enabled).toBe(false);
    if (path.includes("operations")) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
    }
  }
});
