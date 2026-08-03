/**
 * Terminal output capture.
 *
 * herdr pushes `pane_output_changed`, but the payload is only
 * `{pane_id, workspace_id, revision}` — it never carries content, and that
 * topic is not even subscribable (it exists on `EventKind` but not on
 * `Subscription`). There is no PTY byte stream, no screen delta, no frame push
 * anywhere in the protocol. Content only ever arrives by calling `pane.read`.
 *
 * So this polls. Two details make that affordable and correct:
 *
 *  - **Change detection is a content hash.** `revision` looks like the obvious
 *    signal and is useless for this: it stayed at 0 across four reads of a pane
 *    whose text was visibly changing, and `pane.get` reported a constant 2 on an
 *    actively-working agent. It tracks structural changes, not output.
 *
 *  - **The interval is adaptive.** A pane someone is watching is worth 400ms; a
 *    working agent nobody has open is worth a couple of seconds; an idle pane is
 *    worth almost nothing. With no clients connected at all, polling stops
 *    entirely — the dashboard should cost nothing while the phone is asleep.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { HerdrClient } from "./herdr-client";
import type { PaneFrame } from "@shahi/shared";
import { parseActivity } from "./activity";

export type { PaneFrame };
import { parsePrompt, stripAnsi } from "./prompt-parser";
import type { SessionStore } from "./state";
import type { TranscriptStore } from "./transcript";


export interface PollerEvents {
  frame: [PaneFrame];
  error: [Error];
}

/** A pane a client currently has open. */
const WATCHED_INTERVAL_MS = 400;
/** An agent that is working or blocked, but nobody is watching. */
const ACTIVE_INTERVAL_MS = 2_000;
/** Everything else. */
const BACKGROUND_INTERVAL_MS = 15_000;
/** Panes to read per tick, to avoid bursting the socket. */
const BATCH_SIZE = 6;

interface PaneRecord {
  hash: string;
  lastPolledAt: number;
  frame: PaneFrame;
}

export class Poller extends EventEmitter<PollerEvents> {
  readonly #records = new Map<string, PaneRecord>();
  readonly #watchers = new Map<string, number>();
  /** Last time herdr was asked to settle a status the screen disagreed with. */
  readonly #confirmedAt = new Map<string, number>();

  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #clientCount = 0;

  constructor(
    private readonly client: HerdrClient,
    private readonly store: SessionStore,
    private readonly transcript: TranscriptStore,
  ) {
    super();
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.#tick(), 200);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Number of connected clients. At zero, polling pauses entirely. */
  setClientCount(count: number): void {
    this.#clientCount = Math.max(0, count);
  }

  /** The most recent frame for a pane, if one has been captured. */
  frame(paneId: string): PaneFrame | undefined {
    return this.#records.get(paneId)?.frame;
  }

  /**
   * Marks a pane as actively watched, returning an unwatch function.
   *
   * Reference-counted: several clients may have the same pane open.
   */
  watch(paneId: string): () => void {
    this.#watchers.set(paneId, (this.#watchers.get(paneId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#watchers.get(paneId) ?? 1) - 1;
      if (remaining <= 0) this.#watchers.delete(paneId);
      else this.#watchers.set(paneId, remaining);
    };
  }

  /** Reads a pane immediately, bypassing the schedule. */
  async refresh(paneId: string): Promise<PaneFrame | undefined> {
    try {
      return await this.#read(paneId);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return undefined;
    }
  }

  /** Drops cached state for a pane herdr has reported closed. */
  forget(paneId: string): void {
    this.#records.delete(paneId);
    this.#watchers.delete(paneId);
    this.#confirmedAt.delete(paneId);
  }

  #intervalFor(paneId: string): number {
    if (this.#watchers.has(paneId)) return WATCHED_INTERVAL_MS;
    const status = this.store.pane(paneId)?.agent_status;
    return status === "working" || status === "blocked"
      ? ACTIVE_INTERVAL_MS
      : BACKGROUND_INTERVAL_MS;
  }

  async #tick(): Promise<void> {
    // Overlapping ticks would pile requests onto a socket that answers one per
    // connection; skip rather than queue.
    if (this.#ticking) return;

    // Nobody is looking. Watched panes still poll — a client may hold a pane
    // open through a brief reconnect — and so do blocked ones, so that a prompt
    // is already parsed by the time a push notification is tapped. Everything
    // else stops: the dashboard should cost nothing while the phone is asleep.
    const idle = this.#clientCount === 0 && this.#watchers.size === 0;

    this.#ticking = true;
    try {
      const now = Date.now();
      const due = this.store.state.panes
        .filter((p) => !idle || p.agent_status === "blocked" || this.#watchers.has(p.pane_id))
        .map((p) => p.pane_id)
        .filter((paneId) => {
          const last = this.#records.get(paneId)?.lastPolledAt ?? 0;
          return now - last >= this.#intervalFor(paneId);
        })
        // Watched panes first, then oldest read.
        //
        // Interval alone is not priority. A pane never polled has
        // `lastPolledAt = 0`, so on a session this size — 47 panes — every cold
        // pane sorted ahead of the one a client was actually looking at, and a
        // batch of six per tick meant the watched pane waited its turn behind
        // all of them. Short-lived state like codex's five-second working line
        // vanished in the gap.
        .sort((a, b) => {
          const watched = Number(this.#watchers.has(b)) - Number(this.#watchers.has(a));
          if (watched !== 0) return watched;
          return (this.#records.get(a)?.lastPolledAt ?? 0) - (this.#records.get(b)?.lastPolledAt ?? 0);
        })
        .slice(0, BATCH_SIZE);

      await Promise.all(
        due.map((paneId) =>
          this.#read(paneId).catch((err) => {
            // A pane closing between the snapshot and the read is routine.
            if (!isMissingPane(err)) {
              this.emit("error", err instanceof Error ? err : new Error(String(err)));
            }
            this.forget(paneId);
          }),
        ),
      );
    } finally {
      this.#ticking = false;
    }
  }

  async #read(paneId: string): Promise<PaneFrame | undefined> {
    const { read } = await this.client.rpc("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    });

    const existing = this.#records.get(paneId);
    const hash = createHash("sha1").update(read.text).digest("hex");
    const now = Date.now();

    if (existing?.hash === hash) {
      existing.lastPolledAt = now;
      return existing.frame;
    }

    // One read serves all three consumers: xterm.js needs the escapes, the
    // parser and transcript need them gone. Stripping locally avoids a second
    // round-trip for the same screen.
    const text = stripAnsi(read.text);
    const parsed = parsePrompt(text);
    const status = await this.#status(paneId, parsed !== null);

    const frame: PaneFrame = {
      paneId,
      ansi: read.text,
      text,
      // Only offer answer buttons when herdr itself says the agent is waiting.
      // The parser is deliberately strict, but this is the outer guard: a tap
      // sends a real keystroke into a live session.
      prompt: status === "blocked" ? parsed : null,
      // Deliberately not gated on herdr's `agent_status`. Its working-state
      // detection is tuned for Claude Code: a codex pane displaying
      // `• Working (5s • esc to interrupt)` is still reported as `idle`, so
      // gating on it made the indicator impossible for codex regardless of
      // parsing. The status line's presence on the *current* screen is the
      // better signal — both agents clear it the moment the turn ends.
      activity: parseActivity(text),
      at: now,
    };

    // Whatever herdr still holds from before we were watching, once per pane
    // and before the first screen is recorded on top of it.
    if (!existing) await this.#seedHistory(paneId, text);

    this.#records.set(paneId, { hash, lastPolledAt: now, frame });
    this.transcript.record(paneId, text);
    this.emit("frame", frame);
    return frame;
  }

  /**
   * The pane's status, confirmed with herdr when the screen disagrees.
   *
   * The mirror is re-snapshotted every 3 seconds, which is fine for a list and
   * too slow for the pane you are looking at: the screen arrives in 400ms with
   * a question on it, and the answer buttons wait for the mirror to notice.
   * (Status transitions are not on `pane.updated`; they are only announced per
   * pane on `pane.agent_status_changed`, which is why the mirror re-snapshots
   * rather than subscribing — see `state.ts`.)
   *
   * So when the parser finds a menu and the mirror says the agent is not
   * waiting, ask. One extra RPC, in the one window where the mirror is likely
   * to be behind, rate-limited so a screen the parser mis-reads cannot turn
   * every frame into two calls.
   */
  async #status(paneId: string, screenLooksBlocked: boolean): Promise<string | undefined> {
    const mirrored = this.store.pane(paneId)?.agent_status;
    if (!screenLooksBlocked || mirrored === "blocked") return mirrored;

    const now = Date.now();
    if (now - (this.#confirmedAt.get(paneId) ?? 0) < CONFIRM_INTERVAL_MS) return mirrored;
    this.#confirmedAt.set(paneId, now);

    try {
      const { pane } = await this.client.rpc("pane.get", { pane_id: paneId });
      return pane?.agent_status ?? mirrored;
    } catch {
      return mirrored;
    }
  }

  /**
   * Asks herdr for the rows above the current screen, once, when a pane is
   * first read.
   *
   * `source: "recent"` reaches into scrollback where a pane keeps any — a shell
   * or a codex session — and returns just the visible screen where it does not,
   * which is every Claude Code pane. The visible tail is cut off the end
   * because the recorder is about to account for that screen itself; where the
   * two reads disagree, because output arrived between them, the overlap is
   * dropped by length rather than guessed at.
   */
  async #seedHistory(paneId: string, visible: string): Promise<void> {
    if (this.transcript.count(paneId) > 0) return;

    let rows: string[];
    try {
      const { read } = await this.client.rpc("pane.read", {
        pane_id: paneId,
        source: "recent",
        lines: HISTORY_LINES,
        format: "text",
        strip_ansi: true,
      });
      rows = read.text.split("\n").map((line: string) => line.trimEnd());
    } catch {
      // A pane that closed, or a herdr that does not answer. History is a
      // bonus; never let it cost the frame the client is waiting for.
      return;
    }

    const screen = visible.split("\n").map((line) => line.trimEnd());
    while (screen.length > 0 && screen.at(-1) === "") screen.pop();
    while (rows.length > 0 && rows.at(-1) === "") rows.pop();

    const above = rows.slice(0, Math.max(0, rows.length - screen.length));
    if (above.length > 0) this.transcript.seed(paneId, above);
  }
}

/**
 * How far back to ask. herdr caps `lines` at 1000 server-side, so this is the
 * most it will ever give, and it is one read per pane for the life of the
 * process.
 */
const HISTORY_LINES = 1000;

/** Floor between status confirmations for one pane. */
const CONFIRM_INTERVAL_MS = 1_000;

function isMissingPane(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "pane_not_found" || code === "unknown_pane";
}
