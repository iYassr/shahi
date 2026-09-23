/**
 * The harness the socket suites share: what it leaves on disk. It starts and
 * stops its own relay, so it holds none between tests.
 */
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { connectBox, newBox, relayStateDir, startRelay } from "./harness";

/** Where `wrangler dev` keeps Durable Objects when told nothing else. */
const CHECKOUT_STATE = new URL("../.wrangler/state", import.meta.url).pathname;

function files(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).sort();
  } catch {
    return [];
  }
}

test("a relay test run keeps its Durable Objects out of the checkout and leaves none behind", async () => {
  // Left to wrangler's default, relay/.wrangler/state kept every object every
  // run had made, 5,069 databases and 358 MB of them, and alarms from earlier
  // runs fired during later ones (review 2026-09-22, P02-X2).
  const before = files(CHECKOUT_STATE);
  const stop = await startRelay();
  const state = relayStateDir();
  try {
    expect(state?.startsWith(tmpdir())).toBe(true);
    const box = await connectBox(newBox());
    box.close();
    expect(files(state!).some((file) => file.endsWith(".sqlite"))).toBe(true);
    expect(files(CHECKOUT_STATE)).toEqual(before);
  } finally {
    await stop();
  }
  expect(existsSync(state!)).toBe(false);
}, 120_000);
