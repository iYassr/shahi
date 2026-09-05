import type { APIRequestContext, Page } from "@playwright/test";
import type { ScenarioName } from "./data";

/**
 * How a test says what situation it is testing.
 *
 * `await scenario(page, "waiting")` and the app is now looking at four agents
 * that are all blocked, every time, in both engines. That is the whole point of
 * the stub: the situation is chosen rather than waited for.
 */
export async function scenario(page: Page, name: ScenarioName): Promise<void> {
  const res = await page.request.post("/__stub/scenario", { data: { name } });
  if (!res.ok()) throw new Error(`could not set scenario ${name}: ${res.status()}`);
}

/** Everything the app tried to change, in order. Nothing was actually done. */
export async function writes(
  page: Page | APIRequestContext,
): Promise<{ method: string; path: string; body: unknown }[]> {
  const request = "request" in page ? page.request : page;
  const res = await request.get("/__stub/writes");
  return (await res.json()).writes;
}

/** Semantic pane writes, with the route retained for contract assertions. */
export async function paneWrites(page: Page): Promise<{ path: string; body: Record<string, any> }[]> {
  return (await writes(page)).filter((w) => /^\/api\/panes\/[^/]+\/(prompt|answer|keys)$/.test(w.path)) as { path: string; body: Record<string, any> }[];
}

/** Pushes a message down the socket, as the poller would. */
export async function push(page: Page, message: unknown): Promise<void> {
  await page.request.post("/__stub/push", { data: message });
}

/** Kills every socket, so recovery can be tested rather than assumed. */
export async function dropConnections(page: Page): Promise<void> {
  await page.request.post("/__stub/drop", { data: {} });
}
