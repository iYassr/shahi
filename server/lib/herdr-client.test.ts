import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrSubscriber } from "./herdr-client";

/**
 * The event subscription is stopped and started by BackendMonitor on every
 * offline flap, and both halves of that were found broken in the pre-release
 * review: a stop() during a pending retry disabled reconnecting for good, and
 * a connect still in flight at stop() survived as a second subscription.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A socket path nothing is listening on, short enough for macOS's 104-byte sun_path. */
function missingSocket(): string {
  scratch = mkdtempSync(join(tmpdir(), "shahi-sub-"));
  return join(scratch, "none.sock");
}

describe("HerdrSubscriber", () => {
  test("keeps reconnecting after a stop() that lands while a retry is pending", async () => {
    let attempts = 0;
    const subscriber = new HerdrSubscriber(
      { onEvent() {}, onResync() {}, onError: () => void attempts++ },
      missingSocket(),
    );
    try {
      subscriber.start();
      await sleep(100); // the first connect has failed; a 250ms retry is waiting
      expect(attempts).toBe(1);

      subscriber.stop(); // what BackendMonitor does on a tick that finds herdr offline
      subscriber.start(); // and what it does when herdr answers again
      await sleep(50);
      const afterRestart = attempts; // start() connects at once, and fails again

      // A live subscriber retries on its backoff (500ms by now). The broken one
      // believed the cancelled timer was still pending and never tried again.
      await sleep(800);
      expect(attempts).toBeGreaterThan(afterRestart);
    } finally {
      subscriber.stop();
    }
  });

  test("a connection that opens after stop() is closed, not kept beside the new one", async () => {
    scratch = mkdtempSync(join(tmpdir(), "shahi-sub-"));
    const path = join(scratch, "herdr.sock");
    let live = 0;
    let subscribed = 0;
    const listener = Bun.listen({
      unix: path,
      socket: {
        open: () => void live++,
        close: () => void live--,
        data: (socket, chunk) => {
          if (!new TextDecoder().decode(chunk).includes("events.subscribe")) return;
          subscribed++;
          socket.write(`${JSON.stringify({ id: "shahi:subscribe", result: { type: "subscription_started" } })}\n`);
        },
      },
    });
    const subscriber = new HerdrSubscriber({ onEvent() {}, onResync() {}, onError() {} }, path);
    try {
      subscriber.start();
      subscriber.stop(); // the first connect is still in flight
      subscriber.start();
      await sleep(300);

      expect(live).toBe(1);
      expect(subscribed).toBe(1);
    } finally {
      subscriber.stop();
      listener.stop(true);
    }
  });
});
