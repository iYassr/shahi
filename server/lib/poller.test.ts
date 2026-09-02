import { describe, expect, test } from "bun:test";
import { HerdrError, type HerdrClient } from "./herdr-client";
import { Poller } from "./poller";
import type { SessionStore } from "./state";
import { TranscriptStore } from "./transcript";

/**
 * A herdr that answers `pane.read` from two canned screens: the visible one,
 * and the deeper `recent` read that reaches into scrollback.
 */
function fakeHerdr(screens: { visible: string; recent?: string }) {
  const asked: string[] = [];
  const client = {
    rpc: async (_method: string, params: { source: string }) => {
      asked.push(params.source);
      const text = params.source === "recent" ? (screens.recent ?? screens.visible) : screens.visible;
      return { read: { text } };
    },
  } as unknown as HerdrClient;
  return { client, asked };
}

const store = { pane: () => ({ agent_status: "idle" }) } as unknown as SessionStore;

/** A screen with a rendered menu on it: one cursor, numbered options. */
const MENU = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "",
  "❯ 1. Yes, and bypass permissions",
  "  2. Yes, manually approve edits",
  "  3. No, refine the plan",
].join("\n");

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`).join("\n");

describe("history seeding", () => {
  test("keeps what herdr still holds from before the pane was watched", async () => {
    const visible = lines(20, 10);
    const { client, asked } = fakeHerdr({ visible, recent: `${lines(0, 20)}\n${visible}` });
    const transcript = new TranscriptStore(":memory:");

    await new Poller(client, store, transcript).refresh("w1:p1");

    expect(asked).toEqual(["visible", "recent"]);
    // The 20 rows above the screen, and not the screen itself — the recorder
    // accounts for that as it goes.
    expect(transcript.tail("w1:p1", 100).map((line) => line.text)).toEqual(
      lines(0, 20).split("\n"),
    );
  });

  test("records nothing extra for a pane with no scrollback", async () => {
    // Every Claude Code pane: the alternate screen has no rows behind it, so
    // `recent` answers with the visible screen and there is nothing to keep.
    const visible = lines(0, 10);
    const { client } = fakeHerdr({ visible, recent: visible });
    const transcript = new TranscriptStore(":memory:");

    await new Poller(client, store, transcript).refresh("w1:p1");

    expect(transcript.count("w1:p1")).toBe(0);
  });

  test("asks once per pane, not on every poll", async () => {
    const { client, asked } = fakeHerdr({ visible: lines(0, 10), recent: lines(0, 30) });
    const poller = new Poller(client, store, new TranscriptStore(":memory:"));

    await poller.refresh("w1:p1");
    await poller.refresh("w1:p1");
    await poller.refresh("w1:p1");

    expect(asked.filter((source) => source === "recent")).toHaveLength(1);
  });

  // A restart must not lay the same history down a second time on top of what
  // was already recorded from watching.
  test("leaves a pane that already has history alone", async () => {
    const transcript = new TranscriptStore(":memory:");
    transcript.seed("w1:p1", ["already here"]);

    const { client } = fakeHerdr({ visible: lines(0, 10), recent: lines(0, 30) });
    await new Poller(client, store, transcript).refresh("w1:p1");

    expect(transcript.tail("w1:p1", 100).map((line) => line.text)).toEqual(["already here"]);
  });

  // History is a bonus. A pane that closes between the two reads, or a herdr
  // that refuses the second one, must still produce the frame.
  test("still returns the frame when the history read fails", async () => {
    const client = {
      rpc: async (_method: string, params: { source: string }) => {
        if (params.source === "recent") throw new Error("pane_not_found");
        return { read: { text: lines(0, 10) } };
      },
    } as unknown as HerdrClient;

    const frame = await new Poller(client, store, new TranscriptStore(":memory:")).refresh("w1:p1");

    expect(frame?.text).toContain("line 0");
  });
});

/**
 * The mirror is re-snapshotted every 3 seconds; a watched pane arrives every
 * 400ms. So a question can be on screen for seconds before the mirror admits
 * the agent is waiting, and the answer buttons wait with it.
 */
describe("answering sooner than the mirror knows", () => {
  function herdrSaying(status: string, screen: string) {
    const calls: string[] = [];
    const client = {
      rpc: async (method: string, params: { source?: string }) => {
        calls.push(method === "pane.read" ? `read:${params.source}` : method);
        if (method === "pane.get") return { pane: { agent_status: status } };
        return { read: { text: params.source === "recent" ? screen : screen } };
      },
    } as unknown as HerdrClient;
    return { client, calls };
  }

  test("asks herdr when the screen shows a menu and the mirror does not agree", async () => {
    const { client, calls } = herdrSaying("blocked", MENU);
    const frame = await new Poller(client, store, new TranscriptStore(":memory:")).refresh("w1:p1");

    expect(calls).toContain("pane.get");
    expect(frame?.prompt?.options.map((option) => option.label)).toEqual([
      "Yes, and bypass permissions",
      "Yes, manually approve edits",
      "No, refine the plan",
    ]);
  });

  // The outer guard still holds: a tap sends a real keystroke into a live
  // session, so a menu-shaped screen alone is never enough.
  test("offers nothing when herdr says the agent is still working", async () => {
    const { client } = herdrSaying("working", MENU);
    const frame = await new Poller(client, store, new TranscriptStore(":memory:")).refresh("w1:p1");

    expect(frame?.prompt).toBe(null);
  });

  test("does not ask at all for a screen with no menu on it", async () => {
    const { client, calls } = herdrSaying("blocked", lines(0, 10));
    await new Poller(client, store, new TranscriptStore(":memory:")).refresh("w1:p1");

    expect(calls).not.toContain("pane.get");
  });

  // A screen the parser reads as a menu while herdr disagrees would otherwise
  // turn every frame into two calls, forever.
  test("asks at most once a second for the same pane", async () => {
    // The screen has to differ each time, or the poller returns the cached
    // frame on the hash alone and the limiter is never what held it back.
    let tick = 0;
    const calls: string[] = [];
    const client = {
      rpc: async (method: string, params: { source?: string }) => {
        calls.push(method);
        if (method === "pane.get") return { pane: { agent_status: "working" } };
        return { read: { text: `${MENU}\nworking for ${tick++}s` } };
      },
    } as unknown as HerdrClient;
    const poller = new Poller(client, store, new TranscriptStore(":memory:"));

    await poller.refresh("w1:p1");
    await poller.refresh("w1:p1");
    await poller.refresh("w1:p1");

    expect(calls.filter((call) => call === "pane.read")).toHaveLength(4);
    expect(calls.filter((call) => call === "pane.get")).toHaveLength(1);
  });
});

/**
 * When herdr's socket is unreachable, every read fails on connect. The tick
 * fires every 200ms and opens a batch of connections each time, so a herdr
 * that is simply down was measured spinning at ~30 failed connects and ~30
 * error log lines a second. The poller backs off instead, and recovers the
 * instant herdr answers again.
 */
describe("backing off a herdr that is down", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A store with one watched-eligible pane, so a tick has something due every time. */
  function storeWithOnePane(): SessionStore {
    const pane = { pane_id: "w1:p1", agent_status: "idle" };
    return { state: { panes: [pane] }, pane: () => pane } as unknown as SessionStore;
  }

  test("does not hammer herdr while it is unreachable, and resumes when it answers", async () => {
    let calls = 0;
    let mode: "down" | "up" = "down";
    const client = {
      rpc: async () => {
        calls++;
        // A plain connect error, the way `HerdrClient` surfaces a dead socket
        // — not a `HerdrError`, which is herdr answering with a per-pane code.
        if (mode === "down") throw new Error("no herdr socket at /x — is the server running?");
        return { read: { text: "$ " } };
      },
    } as unknown as HerdrClient;

    const poller = new Poller(client, storeWithOnePane(), new TranscriptStore(":memory:"));
    poller.on("error", () => undefined);
    poller.setClientCount(1);
    poller.watch("w1:p1"); // 400ms interval: without backoff it would retry ~every tick
    poller.start();
    try {
      await sleep(300);
      const afterFirstFailure = calls;
      expect(afterFirstFailure).toBeGreaterThanOrEqual(1);

      // The window where an un-backed-off poller would have polled again (at
      // ~400ms and ~800ms). Backed off, it makes no further attempts.
      await sleep(600);
      expect(calls).toBe(afterFirstFailure);

      // herdr comes back: the next retry succeeds, clears the backoff, and the
      // fast cadence resumes rather than staying stuck.
      mode = "up";
      await sleep(900); // past the ~1s backoff, a retry tick lands and succeeds
      const afterRecovery = calls;
      expect(afterRecovery).toBeGreaterThan(afterFirstFailure);
      await sleep(500);
      expect(calls).toBeGreaterThan(afterRecovery);
    } finally {
      poller.stop();
    }
  });

  test("a per-pane herdr error is surfaced, not treated as the socket being down", async () => {
    // A HerdrError means herdr answered — so it must not trip the backoff, or
    // one bad pane would stall polling for every other.
    const errors: string[] = [];
    const client = {
      rpc: async () => {
        throw new HerdrError("pane_busy", "the pane is busy", "pane.read");
      },
    } as unknown as HerdrClient;
    const poller = new Poller(client, storeWithOnePane(), new TranscriptStore(":memory:"));
    poller.on("error", (e) => errors.push(e.message));
    poller.setClientCount(1);
    poller.watch("w1:p1");
    poller.start();
    try {
      await sleep(300);
      const early = errors.length;
      expect(early).toBeGreaterThanOrEqual(1);
      expect(errors.every((m) => !m.includes("backing off"))).toBe(true);
      // Still polling on the fast cadence — the error did not engage a backoff.
      await sleep(600);
      expect(errors.length).toBeGreaterThan(early);
    } finally {
      poller.stop();
    }
  });
});
