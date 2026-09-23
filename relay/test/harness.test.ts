/**
 * The harness the socket suites share: which relay it tests, and what it
 * leaves on disk. It starts and stops its own relay, so it holds none between
 * tests.
 */
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { EXTERNAL, claimPort, connectBox, newBox, relayStateDir, startRelay } from "./harness";

/** Where `wrangler dev` keeps Durable Objects when told nothing else. */
const CHECKOUT_STATE = new URL("../.wrangler/state", import.meta.url).pathname;

function files(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).sort();
  } catch {
    return [];
  }
}

/** A server on a free port for the length of `use`, answering as `fetch` says. */
async function holding(fetch: (request: Request) => Response, use: (port: number) => Promise<void>): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  try {
    await use(server.port!);
  } finally {
    await server.stop(true);
  }
}

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
}

describe("which relay the tests speak to", () => {
  test("a server already on the port is not taken for the relay under test", async () => {
    // Anything that answered 404 at `/` was used as the relay, so a stale
    // `wrangler dev` or another project's server was tested in place of this
    // checkout's code (review 2026-09-22, P02-X3). The run now fails first.
    await holding(() => new Response("not found", { status: 404 }), async (port) => {
      await expect(claimPort(port, false)).rejects.toThrow(`Port ${port} is already in use`);
    });
  });

  test("a port that is taken fails the run even when what holds it is a relay", async () => {
    await holding(() => Response.json({ ok: true, service: "shahi-relay" }), async (port) => {
      await expect(claimPort(port, false)).rejects.toThrow("SHAHI_TEST_RELAY_EXTERNAL=1");
    });
  });

  test("a relay already running is used only when asked for, and only if it is one", async () => {
    await holding(() => Response.json({ ok: true, service: "shahi-relay" }), async (port) => {
      expect(await claimPort(port, true)).toBe("external");
    });
    await holding(() => new Response("not found", { status: 404 }), async (port) => {
      await expect(claimPort(port, true)).rejects.toThrow("no Shahi relay answers");
    });
    await expect(claimPort(await freePort(), true)).rejects.toThrow("no Shahi relay answers");
  });

  test("a free port is where the tests start their own", async () => {
    expect(await claimPort(await freePort(), false)).toBe("start");
  });
});

test.skipIf(EXTERNAL)("a relay test run keeps its Durable Objects out of the checkout and leaves none behind", async () => {
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
