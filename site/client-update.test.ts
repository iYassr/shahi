import { expect, test } from "bun:test";
import { clientUpdate } from "./src/client-update";
import { parseUpdatePolicy } from "../shared/src/client-update";
import { readFileSync } from "node:fs";

test("the independent recovery endpoint is public, never cached, and contains no executable update URL", async () => {
  const response = clientUpdate(new Request("https://getshahi.dev/api/client-update"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(parseUpdatePolicy(await response.json())).not.toBeNull();
  expect(readFileSync(new URL("wrangler.toml", import.meta.url), "utf8")).toContain('run_worker_first = ["/api/client-update",');
});
test("visitors cannot change policy by posting to its public endpoint", async () => {
  expect(clientUpdate(new Request("https://getshahi.dev/api/client-update", { method: "POST", body: "{}" })).status).toBe(405);
  expect(await clientUpdate(new Request("https://getshahi.dev/api/client-update", { method: "HEAD" })).text()).toBe("");
});
