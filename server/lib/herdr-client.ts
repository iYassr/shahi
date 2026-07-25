/**
 * Client for herdr's socket API.
 *
 * Transport is newline-delimited JSON over a unix domain socket. Two behaviours
 * of herdr 0.7.5 drive the shape of this module, and both contradict the
 * official docs at herdr.dev/docs/socket-api:
 *
 *  1. **The server closes the connection after writing one response.** The docs
 *     say connections are persistent and can carry sequential requests; on
 *     0.7.5 a second request on the same socket gets EPIPE, and pipelining two
 *     requests in one write yields one response then ECONNRESET. So `rpc()`
 *     opens a fresh socket per call and never pools.
 *
 *  2. **`events.subscribe` is the sole exception** — it holds the socket open
 *     and streams `{event, data}` lines until either side hangs up.
 *
 * Because this behaviour is undocumented it could change under us, so
 * `connect()` pins the protocol version at startup and complains loudly on a
 * mismatch rather than failing in some subtle way later.
 */
import { connect as bunConnect, type Socket } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HERDR_PROTOCOL,
  type ErrorResponse,
  type EventEnvelope,
  type Request,
  type ResponseResult,
  type SubscriptionEventEnvelope,
  type Subscription,
  type SuccessResponse,
} from "./herdr-schema";

export const DEFAULT_SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");

/** Every method name the server accepts, derived from the generated schema. */
export type Method = Request["method"];

/** The `params` object for a given method. */
export type ParamsFor<M extends Method> = Extract<Request, { method: M }>["params"];

/**
 * Result payload for a given method.
 *
 * The schema discriminates results by `result.type`, not by the method that
 * produced them, so there is no mechanical method->result mapping to generate.
 * The methods this app actually depends on are pinned here; everything else
 * falls back to the full union and gets narrowed at the call site.
 */
interface KnownResults {
  ping: "pong";
  "session.snapshot": "session_snapshot";
  "workspace.list": "workspace_list";
  "tab.list": "tab_list";
  "pane.list": "pane_list";
  "pane.get": "pane_info";
  "pane.read": "pane_read";
  "agent.list": "agent_list";
  "agent.get": "agent_info";
  "agent.read": "pane_read";
  "pane.send_text": "ok";
  "pane.send_keys": "ok";
  "pane.send_input": "ok";
  "pane.focus": "ok";
  "agent.prompt": "agent_prompted";
  "events.subscribe": "subscription_started";
  "workspace.create": "workspace_created";
  "workspace.close": "workspace_closed";
  "tab.create": "tab_created";
  "agent.start": "agent_started";
  "server.agent_manifests": "agent_manifest_status";
}

/**
 * Methods that block on something happening rather than answering immediately,
 * with the ceiling each one needs. Everything else uses the default.
 */
export const SLOW_METHODS: Partial<Record<Method, number>> = {
  // Waits for the agent to reach interactive readiness — 30s default, 300s max.
  "agent.start": 310_000,
  "agent.wait": 310_000,
  "agent.prompt": 310_000,
  "pane.wait_for_output": 310_000,
  "events.wait": 310_000,
};

export type ResultFor<M extends Method> = M extends keyof KnownResults
  ? Extract<ResponseResult, { type: KnownResults[M] }>
  : ResponseResult;

/** An `{id, error}` reply from herdr, surfaced as a throwable. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly method: string,
  ) {
    super(`herdr ${method} failed [${code}]: ${message}`);
    this.name = "HerdrError";
  }
}

export class HerdrProtocolMismatch extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly version: string,
  ) {
    super(
      `herdr speaks protocol ${actual} (v${version}) but these types were ` +
        `generated from protocol ${expected}. Re-run \`bun run gen:types\` ` +
        `and re-check the behaviours documented in herdr-client.ts.`,
    );
    this.name = "HerdrProtocolMismatch";
  }
}

function isErrorResponse(msg: unknown): msg is ErrorResponse {
  return typeof msg === "object" && msg !== null && "error" in msg;
}

/**
 * Splits a byte stream into NDJSON messages across chunk boundaries.
 *
 * herdr's larger payloads (`session.snapshot` is ~29KB here) reliably span
 * multiple TCP reads, and a burst of events can pack several messages into one
 * chunk, so neither "one chunk is one message" nor "one message is one chunk"
 * holds.
 */
class LineBuffer {
  #buf = "";

  push(chunk: Uint8Array): string[] {
    this.#buf += new TextDecoder().decode(chunk);
    const parts = this.#buf.split("\n");
    this.#buf = parts.pop() ?? "";
    return parts.filter((line) => line.trim().length > 0);
  }
}

export interface HerdrClientOptions {
  socketPath?: string;
  /** Per-request timeout. herdr replies in single-digit ms locally. */
  timeoutMs?: number;
}

export class HerdrClient {
  readonly socketPath: string;
  readonly #timeoutMs: number;
  #requestSeq = 0;

  constructor(options: HerdrClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  /**
   * Issues one request on its own connection and resolves with `result`.
   *
   * Do not be tempted to pool these — see the module docstring.
   *
   * `timeoutMs` overrides the default for calls that legitimately block.
   * `agent.start` is the motivating case: it waits for the agent to reach
   * interactive readiness, up to 30s by default and 300s if asked, so the
   * ordinary 5s ceiling would fail it every time.
   */
  async rpc<M extends Method>(
    method: M,
    params: ParamsFor<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<ResultFor<M>> {
    const id = `herdrui:${++this.#requestSeq}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    return new Promise<ResultFor<M>>((resolve, reject) => {
      const lines = new LineBuffer();
      let socket: Socket<undefined> | undefined;
      let settled = false;

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`herdr ${method} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      /** Settle once, always tearing down the socket and timer. */
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.end();
        } catch {
          // Already closed by the server; nothing to clean up.
        }
        settle();
      };

      bunConnect({
        unix: this.socketPath,
        socket: {
          open: (s) => void s.write(payload),
          data: (_s, chunk) => {
            for (const line of lines.push(chunk)) {
              let msg: SuccessResponse | ErrorResponse;
              try {
                msg = JSON.parse(line);
              } catch {
                finish(() =>
                  reject(new Error(`herdr ${method} returned malformed JSON: ${line.slice(0, 200)}`)),
                );
                return;
              }
              if (isErrorResponse(msg)) {
                finish(() => reject(new HerdrError(msg.error.code, msg.error.message, method)));
              } else {
                finish(() => resolve(msg.result as ResultFor<M>));
              }
              return;
            }
          },
          // The server hangs up after every response, so a close *after* we have
          // settled is the normal path and must not be treated as an error.
          close: () => finish(() => reject(new Error(`herdr closed the socket before answering ${method}`))),
          error: (_s, err) => finish(() => reject(err)),
        },
      }).then(
        (s) => {
          socket = s;
          if (settled) s.end();
        },
        (err) => finish(() => reject(wrapConnectError(err, this.socketPath))),
      );
    });
  }

  /** Verifies the server is reachable and speaking the protocol we generated against. */
  async connect(): Promise<{ version: string; protocol: number }> {
    const pong = await this.rpc("ping", {});
    if (pong.protocol !== HERDR_PROTOCOL) {
      throw new HerdrProtocolMismatch(HERDR_PROTOCOL, pong.protocol, pong.version);
    }
    return { version: pong.version, protocol: pong.protocol };
  }
}

function wrapConnectError(err: unknown, socketPath: string): Error {
  const code = (err as { code?: string })?.code;
  if (code === "ENOENT") {
    return new Error(
      `no herdr socket at ${socketPath} — is the server running? (\`herdr status server\`)`,
    );
  }
  if (code === "EACCES") {
    return new Error(`permission denied on ${socketPath} — it is owner-only by design (0600)`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/* -------------------------------------------------------------------------- */
/*                              Event subscription                            */
/* -------------------------------------------------------------------------- */

export type AnyEvent = EventEnvelope | SubscriptionEventEnvelope;

export interface SubscriberHandlers {
  onEvent: (event: AnyEvent) => void;
  /**
   * Fires after every successful (re)subscribe, including the first.
   *
   * Events that occurred while disconnected are simply lost — herdr has no
   * replay — so consumers must treat this as "resync from scratch now" and
   * re-issue `session.snapshot`.
   */
  onResync: () => void | Promise<void>;
  onError?: (err: Error) => void;
}

/**
 * Holds a persistent subscription connection, reconnecting with backoff.
 *
 * One connection is enough for whole-session awareness: the unfiltered
 * `pane.updated` topic carries a full `PaneInfo` (including `agent_status`) for
 * every pane, so there is no need for per-pane `pane.agent_status_changed`
 * subscriptions, which would each require an explicit `pane_id`.
 */
export class HerdrSubscriber {
  #socket: Socket<undefined> | undefined;
  #stopped = false;
  #backoffMs = 250;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  static readonly DEFAULT_TOPICS: Subscription[] = [
    { type: "pane.created" },
    { type: "pane.updated" },
    { type: "pane.closed" },
    { type: "pane.focused" },
    { type: "pane.exited" },
    { type: "pane.moved" },
    { type: "pane.agent_detected" },
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "workspace.metadata_updated" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.renamed" },
    { type: "tab.moved" },
    { type: "tab.focused" },
    { type: "worktree.created" },
    { type: "worktree.opened" },
    { type: "worktree.removed" },
    { type: "layout.updated" },
  ];

  private static readonly MAX_BACKOFF_MS = 15_000;

  constructor(
    private readonly handlers: SubscriberHandlers,
    private readonly socketPath: string = DEFAULT_SOCKET_PATH,
    private readonly topics: Subscription[] = HerdrSubscriber.DEFAULT_TOPICS,
  ) {}

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    try {
      this.#socket?.end();
    } catch {
      // Already gone.
    }
    this.#socket = undefined;
  }

  #open(): void {
    if (this.#stopped) return;
    const lines = new LineBuffer();

    bunConnect({
      unix: this.socketPath,
      socket: {
        open: (s) => {
          this.#socket = s;
          s.write(
            `${JSON.stringify({
              id: "herdrui:subscribe",
              method: "events.subscribe",
              params: { subscriptions: this.topics },
            })}\n`,
          );
        },
        data: (_s, chunk) => {
          for (const line of lines.push(chunk)) {
            let msg: unknown;
            try {
              msg = JSON.parse(line);
            } catch {
              this.handlers.onError?.(new Error(`malformed event JSON: ${line.slice(0, 200)}`));
              continue;
            }

            // The subscribe ack arrives first; treat it as "we are live again".
            if (isSubscriptionAck(msg)) {
              this.#backoffMs = 250;
              void this.handlers.onResync();
              continue;
            }
            if (isErrorResponse(msg)) {
              this.handlers.onError?.(
                new HerdrError(msg.error.code, msg.error.message, "events.subscribe"),
              );
              continue;
            }
            if (isEventEnvelope(msg)) this.handlers.onEvent(msg);
          }
        },
        close: () => this.#scheduleReconnect(),
        error: (_s, err) => {
          this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
          this.#scheduleReconnect();
        },
      },
    }).catch((err) => {
      this.handlers.onError?.(wrapConnectError(err, this.socketPath));
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#socket = undefined;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, HerdrSubscriber.MAX_BACKOFF_MS);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#open();
    }, delay);
  }
}

function isSubscriptionAck(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { result?: { type?: string } }).result?.type === "subscription_started"
  );
}

function isEventEnvelope(msg: unknown): msg is AnyEvent {
  return typeof msg === "object" && msg !== null && "event" in msg && "data" in msg;
}
