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
import { parsePrompt, stripAnsi, type ParsedPrompt } from "./prompt-parser";
import type { SessionStore } from "./state";
import type { TranscriptStore } from "./transcript";

export interface PaneFrame {
  paneId: string;
  /** Raw screen including escape sequences, for xterm.js. */
  ansi: string;
  /** Same screen with escapes stripped, for parsing and the transcript. */
  text: string;
  /** Parsed prompt when the agent is blocked and the screen is well-formed. */
  prompt: ParsedPrompt | null;
  at: number;
}

export interface PollerEvents {
  frame: [PaneFrame];
  error: [Error];
}

export interface PollerOptions {
  /** A pane a client currently has open. */
  watchedIntervalMs?: number;
  /** An agent that is working or blocked, but nobody is watching. */
  activeIntervalMs?: number;
  /** Everything else. */
  backgroundIntervalMs?: number;
  /** Panes to read per tick, to avoid bursting the socket. */
  batchSize?: number;
}

const DEFAULTS = {
  watchedIntervalMs: 400,
  activeIntervalMs: 2_000,
  backgroundIntervalMs: 15_000,
  batchSize: 6,
} satisfies Required<PollerOptions>;

interface PaneRecord {
  hash: string;
  lastPolledAt: number;
  frame: PaneFrame;
}

export class Poller extends EventEmitter<PollerEvents> {
  readonly #options: Required<PollerOptions>;
  readonly #records = new Map<string, PaneRecord>();
  readonly #watchers = new Map<string, number>();

  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #clientCount = 0;

  constructor(
    private readonly client: HerdrClient,
    private readonly store: SessionStore,
    private readonly transcript: TranscriptStore,
    options: PollerOptions = {},
  ) {
    super();
    this.#options = { ...DEFAULTS, ...options };
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
  }

  #intervalFor(paneId: string): number {
    if (this.#watchers.has(paneId)) return this.#options.watchedIntervalMs;
    const status = this.store.pane(paneId)?.agent_status;
    return status === "working" || status === "blocked"
      ? this.#options.activeIntervalMs
      : this.#options.backgroundIntervalMs;
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
        // Oldest read first, so no pane is starved by a busy neighbour.
        .sort(
          (a, b) =>
            (this.#records.get(a)?.lastPolledAt ?? 0) - (this.#records.get(b)?.lastPolledAt ?? 0),
        )
        .slice(0, this.#options.batchSize);

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
    const status = this.store.pane(paneId)?.agent_status;

    const frame: PaneFrame = {
      paneId,
      ansi: read.text,
      text,
      // Only offer answer buttons when herdr itself says the agent is waiting.
      // The parser is deliberately strict, but this is the outer guard: a tap
      // sends a real keystroke into a live session.
      prompt: status === "blocked" ? parsePrompt(text) : null,
      at: now,
    };

    this.#records.set(paneId, { hash, lastPolledAt: now, frame });
    this.transcript.record(paneId, text);
    this.emit("frame", frame);
    return frame;
  }
}

function isMissingPane(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "pane_not_found" || code === "unknown_pane";
}
