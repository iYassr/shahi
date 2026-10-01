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
import { EventEmitter } from "node:events";
import { HerdrError, type HerdrClient } from "./herdr-client";
import type { PaneFrame } from "@shahi/shared";
import { parseActivity } from "./activity";

export type { PaneFrame };
import { parsePrompt, stripAnsi, type ParsedPrompt } from "./prompt-parser";
import { providerIsWaiting, providerWaitingScreen } from "./provider-prompts";
import { PromptInstances, screenId } from "./prompt-instances";
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
/** First wait after herdr is found unreachable; doubles up to the cap. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface PaneRecord {
  hash: string;
  lastPolledAt: number;
  frame: PaneFrame;
  /** The menu this screen shows, whether or not herdr agreed the agent was waiting when it was read. */
  parsed: ParsedPrompt | null;
  /** Which occupancy of the pane id this was read from (see `PaneInstances`). */
  instance: string | undefined;
}

export class Poller extends EventEmitter<PollerEvents> {
  /** Which appearance of a prompt each screen shows; the answer route observes through the same one. */
  readonly prompts = new PromptInstances();
  readonly #records = new Map<string, PaneRecord>();
  readonly #watchers = new Map<string, number>();
  /** Last time herdr was asked to settle a status the screen disagreed with. */
  readonly #confirmedAt = new Map<string, number>();

  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #clientCount = 0;
  /** Consecutive ticks that found herdr unreachable, and when to try again. */
  #connectFailures = 0;
  #retryAt = 0;

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
    this.prompts.forget(paneId);
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

    // herdr is unreachable and we are waiting out the backoff. Without this a
    // tick fired every 200ms and opened BATCH_SIZE connections that each
    // failed — measured at ~30 failed connects and 30 error log lines a second
    // against a herdr that was simply down. The wait grows on each consecutive
    // failure and is cleared the instant a read succeeds again.
    if (Date.now() < this.#retryAt) return;

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

      const results = await Promise.allSettled(due.map((paneId) => this.#read(paneId)));

      let anyOk = false;
      let unreachable: Error | null = null;
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          anyOk = true;
          return;
        }
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        // A pane closing between the snapshot and the read is routine, and the
        // only case that should drop the watch. A transient read failure must
        // NOT forget the pane — doing so tore down a watcher the WebSocket
        // still believed was live, and it never recovered. Keep it; the next
        // tick retries.
        if (isMissingPane(err)) {
          this.forget(due[i]!);
        } else if (err instanceof HerdrError) {
          // herdr answered, with a per-pane refusal: not a connection problem,
          // so it is surfaced as before and does not trip the backoff.
          this.emit("error", err);
        } else {
          // A connection or timeout error: herdr itself is unreachable. The
          // whole batch fails the same way, so it is reported once, not once
          // per pane.
          unreachable = err;
        }
      });

      if (anyOk) {
        this.#connectFailures = 0;
        this.#retryAt = 0;
      } else if (unreachable) {
        this.#connectFailures += 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.#connectFailures - 1));
        this.#retryAt = Date.now() + delay;
        this.emit("error", new Error(`herdr unreachable (${(unreachable as Error).message}); backing off ${delay}ms`));
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #read(paneId: string): Promise<PaneFrame | undefined> {
    const ticket = this.prompts.ticket(paneId);
    const { read } = await this.client.rpc("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    });

    // A pane id another program has taken since the last read is a new pane:
    // the old screen is not its screen, and its own scrollback is still to be
    // seeded. The recorder's rows follow the same occupancy.
    const instance = this.store.instance(paneId);
    const held = this.#records.get(paneId);
    const existing = held?.instance === instance ? held : undefined;
    if (instance) this.transcript.claim(paneId, instance);
    const hash = screenId(read.text);
    const now = Date.now();

    if (existing?.hash === hash) {
      existing.lastPolledAt = now;
      const promptId = this.prompts.observe(paneId, ticket, existing.parsed, hash);
      // The screen has not changed, but herdr's opinion of it may have. A new
      // agent's folder-trust menu is on screen while herdr still reports it
      // `unknown` (measured: several seconds after `agent.start`), and a
      // static menu never changes the hash again — so the frame cached in that
      // window kept `prompt: null`, and the card for a waiting agent had no
      // answer buttons for as long as it waited (pre-release review). Ask
      // again, through the same rate-limited confirmation a new screen gets.
      //
      // Its prompt's id can move on an unchanged screen too: an identical
      // question drawn over an identical screen after an answer. A card left
      // on the old id would be refused for good. The answered screen itself
      // is not re-sent, or the card just answered would flash back.
      const current = existing.frame.prompt;
      const stale = current !== null && promptId !== undefined && current.promptId !== promptId &&
        !this.prompts.alreadyAnswered(paneId, hash);
      // Only while the answer could change what is shown: a menu without its
      // buttons, or a screen with no menu, which may be waiting on something
      // unrecognised. A card already shown stays until the screen changes.
      const asks = !stale && !(existing.parsed && current) ? await this.#asks(paneId, existing.parsed, existing.frame.text) : null;
      const offer = stale || (asks?.offer ?? false);
      const unrecognised = asks?.unrecognised ?? existing.frame.unrecognised === true;
      if (offer || unrecognised !== (existing.frame.unrecognised === true)) {
        // A read that finished meanwhile holds a newer screen; keep that.
        const latest = this.#records.get(paneId);
        if (latest !== existing) return latest?.frame;
        const { unrecognised: _, ...rest } = existing.frame;
        existing.frame = { ...rest, prompt: offer ? withId(existing.parsed!, promptId) : current, ...(unrecognised ? { unrecognised: true } : {}), at: now };
        this.emit("frame", existing.frame);
      }
      return existing.frame;
    }

    // One read serves all three consumers: xterm.js needs the escapes, the
    // transcript needs them gone. The parser retains colour for OpenCode's
    // horizontal selection. One read keeps those views on the same screen.
    const text = stripAnsi(read.text);
    const parsed = parsePrompt(read.text);
    const promptId = this.prompts.observe(paneId, ticket, parsed, hash);
    const { offer, unrecognised } = await this.#asks(paneId, parsed, text);

    const frame: PaneFrame = {
      paneId,
      ansi: read.text,
      text,
      prompt: offer && parsed ? withId(parsed, promptId) : null,
      ...(unrecognised ? { unrecognised: true } : {}),
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

    this.#records.set(paneId, { hash, lastPolledAt: now, frame, parsed, instance });
    this.transcript.record(paneId, text);
    this.emit("frame", frame);
    return frame;
  }

  /**
   * What the screen asks of the person: the answer buttons for the menu the
   * parser found (`offer`), or the screen itself (`unrecognised`) when an
   * agent waits and no menu was recognised: herdr says it is blocked, or the
   * screen is one measured to wait with nothing to choose.
   *
   * The buttons follow the write guard in `prompt.ts`, which refuses a
   * message whenever the parser finds a menu on an agent's screen, whatever
   * herdr says. They used to wait for herdr's `blocked` as well, and herdr
   * 0.9.1 reports Codex's startup menus — its update offer, a model
   * migration, a hooks review — `idle`: the message was refused and nothing
   * was offered to answer it with. So an agent gets them for any menu while
   * herdr does not say it is working. A numbered list in a turn still being
   * written is asked of nobody, and a menu mid-turn is known by herdr's
   * `blocked`. A pane herdr names no agent in keeps the old rule: its shell
   * may be showing a menu some earlier program left behind.
   *
   * The mirror is re-snapshotted every 3 seconds, which is fine for a list and
   * too slow for the pane you are looking at: the screen arrives in 400ms with
   * a question on it, and the answer buttons wait for the mirror to notice.
   * (Status transitions are not on `pane.updated`; they are only announced per
   * pane on `pane.agent_status_changed`, which is why the mirror re-snapshots
   * rather than subscribing — see `state.ts`.) So when the mirror's word would
   * withhold the buttons, or show the screen for a wait herdr may have ended,
   * ask. One extra RPC, rate-limited so a screen the parser mis-reads cannot
   * turn every frame into two calls.
   */
  async #asks(paneId: string, parsed: ParsedPrompt | null, text: string): Promise<{ offer: boolean; unrecognised: boolean }> {
    const mirrored = this.store.pane(paneId);
    if (providerIsWaiting(mirrored?.agent, text, parsed)) return { offer: true, unrecognised: false };
    // A measured screen that waits with nothing to choose waits whatever herdr says.
    const waiting = parsed === null && providerWaitingScreen(text);
    const decide = (pane: { agent?: string | null; agent_status?: string | null } | undefined) => ({
      offer: parsed !== null && (pane?.agent_status === "blocked" || (!!pane?.agent && pane.agent_status !== "working")),
      unrecognised: parsed === null && !!pane?.agent && (pane.agent_status === "blocked" || waiting),
    });
    const guess = decide(mirrored);
    if (parsed ? guess.offer : !guess.unrecognised || waiting) return guess;

    const now = Date.now();
    if (now - (this.#confirmedAt.get(paneId) ?? 0) < CONFIRM_INTERVAL_MS) return guess;
    this.#confirmedAt.set(paneId, now);

    try {
      const { pane } = await this.client.rpc("pane.get", { pane_id: paneId });
      return decide({ ...mirrored, ...pane });
    } catch {
      return guess;
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

/** A read overtaken by a later one has no id to give, and its prompt goes out as older servers sent it. */
function withId(prompt: ParsedPrompt, promptId: string | undefined): ParsedPrompt {
  return promptId === undefined ? prompt : { ...prompt, promptId };
}

function isMissingPane(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "pane_not_found" || code === "unknown_pane";
}
