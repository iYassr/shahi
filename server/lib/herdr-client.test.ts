import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrSubscriber, MAX_REQUEST_BYTES, RequestTooLarge } from "./herdr-client";

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

/**
 * A request is one JSON line, and herdr acts on nothing until its newline
 * arrives. A macOS unix socket takes 8192 bytes per write, and the rest was
 * dropped, so every request over that timed out having delivered nothing
 * (pre-release bug hunt, B2). The listener here answers only a complete line,
 * as herdr does.
 */
describe("a request larger than the socket's send buffer", () => {
  /** A herdr stand-in that keeps each complete request line and answers `ok`. */
  function echoHerdr() {
    scratch = mkdtempSync(join(tmpdir(), "shahi-big-"));
    const path = join(scratch, "herdr.sock");
    const lines: string[] = [];
    const listener = Bun.listen<{ chunks: Uint8Array[] }>({
      unix: path,
      socket: {
        open: (socket) => void (socket.data = { chunks: [] }),
        data: (socket, chunk) => {
          socket.data.chunks.push(new Uint8Array(chunk));
          const received = Buffer.concat(socket.data.chunks);
          const end = received.indexOf(0x0a);
          if (end < 0) return;
          // Fatal, so a request cut inside a character fails here rather than
          // arriving with a replacement character in it.
          const line = new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, end));
          lines.push(line);
          const request = JSON.parse(line) as { id: string };
          socket.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
          socket.end();
        },
      },
    });
    return { path, lines, stop: () => listener.stop(true) };
  }

  /** Sends `text` through a real client and returns the text herdr received. */
  async function delivered(herdr: ReturnType<typeof echoHerdr>, text: string): Promise<string> {
    const client = new HerdrClient({ socketPath: herdr.path, timeoutMs: 2_000 });
    await client.rpc("pane.send_text", { pane_id: "w1:p1", text });
    expect(herdr.lines).toHaveLength(1);
    return (JSON.parse(herdr.lines[0]!) as { params: { text: string } }).params.text;
  }

  test("a prompt over 8 KB reaches herdr whole", async () => {
    const herdr = echoHerdr();
    try {
      const text = "y".repeat(70_000);
      expect(await delivered(herdr, text)).toBe(text);
    } finally {
      herdr.stop();
    }
  });

  // 2,100 emoji was one of the reported shapes: four bytes each, so a write
  // can stop inside a character, and what is left has to be counted in bytes.
  test("multibyte text over 8 KB arrives intact", async () => {
    const herdr = echoHerdr();
    try {
      const text = `${"🐑".repeat(2_100)} and a tail`;
      expect(await delivered(herdr, text)).toBe(text);
    } finally {
      herdr.stop();
    }
  });

  // herdr answers nothing to a line over 1 MiB and hangs up, which is an
  // uncertain failure; one refused before writing is a certain one.
  test("a request longer than herdr reads is refused before a byte is written", async () => {
    const herdr = echoHerdr();
    try {
      const client = new HerdrClient({ socketPath: herdr.path, timeoutMs: 2_000 });
      const sending = client.rpc("pane.send_text", { pane_id: "w1:p1", text: "y".repeat(MAX_REQUEST_BYTES) });
      await expect(sending).rejects.toBeInstanceOf(RequestTooLarge);
      await expect(sending).rejects.toMatchObject({ code: "EMSGSIZE" });
      await sleep(50);
      expect(herdr.lines).toEqual([]);
    } finally {
      herdr.stop();
    }
  });

  test("the event subscription's request is written whole too", async () => {
    const herdr = echoHerdr();
    const topics = Array.from({ length: 1_000 }, () => ({ type: "pane.updated" as const }));
    const subscriber = new HerdrSubscriber({ onEvent() {}, onResync() {}, onError() {} }, herdr.path, topics);
    try {
      subscriber.start();
      for (let waited = 0; herdr.lines.length === 0 && waited < 2_000; waited += 25) await sleep(25);
      expect(herdr.lines).toHaveLength(1);
      const request = JSON.parse(herdr.lines[0]!) as { params: { subscriptions: unknown[] } };
      expect(request.params.subscriptions).toHaveLength(1_000);
    } finally {
      subscriber.stop();
      herdr.stop();
    }
  });
});
