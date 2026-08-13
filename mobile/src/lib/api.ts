/**
 * Client for the Shahi server, for React Native.
 *
 * Every wire type comes from `@shahi/shared`, the same module the web client
 * imports — which is the whole reason that package exists. The differences
 * between the two clients are genuinely small:
 *
 *  - There is no same-origin. The server address has to be configured, and it
 *    is a tailnet address rather than a hostname the phone can guess.
 *  - There is no cookie jar shared with a browser, so the session cookie is
 *    kept and sent explicitly.
 *
 * `fetch` and `WebSocket` are both present in React Native, so the transport is
 * otherwise identical.
 */
import type {
  DirListing,
  InstalledAgent,
  PaneFrame,
  Session,
  SessionLog,
  SocketMessage,
  StoredUpload,
  TranscriptLine,
} from "@shahi/shared";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export interface Connection {
  /** e.g. `http://ubuntu.tailnet01.ts.net:7171` */
  baseUrl: string;
  /** `shahi_session=…`, held here because there is no browser cookie jar. */
  cookie: string | null;
}

/**
 * Mutable so the socket and every request see the same credentials without
 * threading them through each call site.
 */
export const connection: Connection = { baseUrl: "", cookie: null };

/**
 * How long any single request may hang before it is aborted. A dead host used
 * to leave Connect or an action busy forever, because `fetch` has no timeout of
 * its own; this bounds it and surfaces a plain "timed out" the UI can recover
 * from. Generous enough for a slow tailnet or a cold agent, short enough not to
 * feel stuck.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Runs `fetch` with an abort-on-timeout, turning the abort into a clear error. */
export async function fetchWithTimeout(url: string, init: RequestInit, ms = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("The server didn't respond — it may be unreachable.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!connection.baseUrl) throw new Error("No server address configured");

  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (connection.cookie) headers.cookie = connection.cookie;

  // `credentials: "omit"` turns off the native cookie jar for this request. On
  // iOS, NSURLSession manages cookies itself and overrides a manually-set
  // `cookie` header with whatever its jar holds — observed live: login returns
  // 200 and sets the cookie, the next request 401s with the header
  // demonstrably set, and the resulting UnauthorizedError signs the app out
  // again. This client owns its cookie, because there is no browser to own it;
  // the jar must not compete for the job.
  const res = await fetchWithTimeout(`${connection.baseUrl}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  authStatus: () => request<{ required: boolean; authenticated: boolean }>("/api/auth/status"),

  /** Captures the session cookie, since there is no browser to hold it. */
  login: async (passcode: string) => {
    const res = await fetchWithTimeout(`${connection.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
      // Keep the response cookie out of the native jar: this client stores it
      // itself, and a jar copy would then fight the manual header. See
      // `request`.
      credentials: "omit",
    });
    // Only a 401 is actually a bad passcode. A 502/503/504 means the address is
    // reached but the sidecar behind it is not (e.g. a `tailscale serve` proxy
    // pointing at the wrong port) — calling that "wrong passcode" sent people
    // hunting for the wrong problem.
    if (res.status === 401) throw new Error("That passcode did not work.");
    if (!res.ok)
      throw new Error(
        `Reached the address but not the server (HTTP ${res.status}). Check that the sidecar is running and that any TLS proxy points at it.`,
      );
    connection.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] || null;
    if (!connection.cookie) throw new Error("Server did not return a session");
    return connection.cookie;
  },

  session: () => request<Session>("/api/session"),

  pane: (paneId: string) =>
    request<{ frame: PaneFrame | null; layout: { area: { width: number; height: number } } | null }>(
      `/api/panes/${encodeURIComponent(paneId)}`,
    ),

  sessionLog: (paneId: string, limit = 60) =>
    request<SessionLog>(`/api/panes/${encodeURIComponent(paneId)}/session?limit=${limit}`),

  transcript: (paneId: string) =>
    request<{ lines: TranscriptLine[]; total: number }>(
      `/api/panes/${encodeURIComponent(paneId)}/transcript`,
    ),

  agents: () => request<{ agents: InstalledAgent[]; known: number }>("/api/agents"),

  dirs: (path = "~", files = false) =>
    request<DirListing>(`/api/dirs?path=${encodeURIComponent(path)}${files ? "&files=1" : ""}`),

  rpc: (method: string, params: unknown = {}) =>
    postJson<{ result: unknown }>("/api/rpc", { method, params }),

  /**
   * Makes a tab and starts an agent in it, in one call.
   *
   * The two herdr calls behind this race each other — the pane exists before
   * its shell does — so the server owns the sequence and the retry. herdr then
   * blocks until the agent is interactively ready, which on a cold start is
   * tens of seconds.
   */
  startAgent: (options: {
    workspaceId: string;
    cwd: string | null;
    label: string | null;
    kind: string;
    name: string;
    /** A mode id, not flags: the server resolves it. */
    mode: string | null;
  }) => postJson<{ paneId: string; tabId: string | null }>("/api/agents/start", options),

  /**
   * Reads a file an agent touched.
   *
   * Text and images arrive down the same route and are told apart by
   * content-type, because the server decides that — it serves HTML and SVG as
   * `text/plain` so agent-written markup cannot run anywhere. Reads are scoped
   * to $HOME and /tmp server-side.
   */
  readFile: async (path: string): Promise<{ text: string } | { imageUrl: string }> => {
    if (!connection.baseUrl) throw new Error("No server address configured");
    const url = `${connection.baseUrl}/api/file?path=${encodeURIComponent(path)}`;
    // Through fetchWithTimeout like every other request: a raw fetch here hung
    // the file viewer forever on a dead host (data-fetching audit).
    const res = await fetchWithTimeout(url, {
      headers: connection.cookie ? { cookie: connection.cookie } : undefined,
      credentials: "omit",
    });
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `could not read that file (${res.status})`);
    }
    // The URL is handed back rather than the bytes: `Image` fetches it itself,
    // and passing megabytes of base64 through JS to get there would be worse.
    if ((res.headers.get("content-type") ?? "").startsWith("image/")) return { imageUrl: url };
    return { text: await res.text() };
  },

  /**
   * Answers a numbered prompt by pressing its digit, exactly as the TUI does.
   * Verified against a live pane: `keys: ["2"]` puts a literal `2` on stdin.
   */
  answerPrompt: (paneId: string, optionIndex: number) =>
    api.rpc("pane.send_keys", { pane_id: paneId, keys: [String(optionIndex)] }),

  /**
   * Sends a message.
   *
   * The gap before Enter is required, not defensive: codex's composer needs a
   * moment to ingest inserted text before Enter counts as submit, and without
   * it the message sits in the box and Send silently does nothing.
   */
  send: async (paneId: string, text: string) => {
    await api.rpc("pane.send_text", { pane_id: paneId, text });
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    await api.rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  },

  sendKeys: (paneId: string, keys: string[]) =>
    api.rpc("pane.send_keys", { pane_id: paneId, keys }),

  /** Registers this device for notifications. See `lib/push`. */
  registerPush: (token: string) => postJson<{ ok: boolean }>("/api/push/expo", { token }),

  unregisterPush: (token: string) =>
    postJson<{ ok: boolean }>("/api/push/expo/unsubscribe", { token }),

  upload: async (file: { uri: string; name: string; type: string }): Promise<StoredUpload> => {
    const body = new FormData();
    // React Native's FormData takes this shape rather than a File.
    body.append("file", { uri: file.uri, name: file.name, type: file.type } as never);
    // A photo over a slow tailnet needs longer than the default 15s, but still
    // a bound: a raw fetch here hung forever on a dead host (data-fetching audit).
    const res = await fetchWithTimeout(
      `${connection.baseUrl}/api/uploads`,
      {
        method: "POST",
        headers: connection.cookie ? { cookie: connection.cookie } : {},
        body,
        credentials: "omit", // see `request`
      },
      60_000,
    );
    const payload = (await res.json().catch(() => ({}))) as StoredUpload & { error?: string };
    if (!res.ok || !payload.path) throw new Error(payload.error ?? "upload failed");
    return payload;
  },
};

/** See `api.send`. Measured against a live codex pane: 150ms sufficed. */
const SUBMIT_DELAY_MS = 200;

/* -------------------------------------------------------------------------- */

export type LinkState = "connecting" | "live" | "lost";

/** How long the server may be silent before the connection counts as dead. */
const SILENCE_LIMIT_MS = 70_000;
const WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Holds the live connection, reconnecting on its own.
 *
 * Same shape as the web client's socket, with one difference: the session
 * cookie is attached explicitly, because React Native has no browser cookie jar
 * to do it automatically.
 */
export class SessionSocket {
  #socket: WebSocket | undefined;
  #backoffMs = 500;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #lastMessageAt = 0;
  #closed = false;
  #watching: string | null = null;

  constructor(
    private readonly onMessage: (msg: SocketMessage) => void,
    private readonly onLink: (state: LinkState) => void,
  ) {}

  connect(): void {
    this.#closed = false;
    this.#open();
    // A socket can die without saying so — a phone sleeping, a network changing
    // under it, a proxy dropping it without a close frame — leaving the app
    // showing "live" over stale agents. The server's heartbeat makes that
    // detectable; this is what acts on the silence.
    this.#watchdog ??= setInterval(() => this.#checkAlive(), WATCHDOG_INTERVAL_MS);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  /** Reconnects now if the connection is not up — for coming back to the app. */
  ensureConnected(): void {
    if (this.#closed) return;
    if (this.#socket?.readyState === 1) {
      this.#checkAlive();
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#backoffMs = 500;
    this.#open();
  }

  #checkAlive(): void {
    if (this.#closed || this.#socket?.readyState !== 1) return;
    if (Date.now() - this.#lastMessageAt < SILENCE_LIMIT_MS) return;
    this.onLink("lost");
    this.#socket.close();
  }

  watch(paneId: string | null): void {
    this.#watching = paneId;
    if (this.#socket?.readyState !== 1) return;
    this.#socket.send(JSON.stringify(paneId ? { type: "watch", paneId } : { type: "unwatch" }));
  }

  #open(): void {
    if (this.#closed || !connection.baseUrl) return;
    this.onLink("connecting");

    const url = connection.baseUrl.replace(/^http/, "ws");

    // React Native's WebSocket takes a third options argument carrying headers,
    // which is how the session cookie travels — there is no browser cookie jar
    // to attach it automatically. The DOM lib types that ship with TypeScript
    // describe the browser's two-argument constructor, so the cast is about the
    // type definitions rather than the runtime.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> },
    ) => WebSocket;

    const socket = new RNWebSocket(`${url}/ws`, undefined, {
      headers: connection.cookie ? { cookie: connection.cookie } : {},
    });
    this.#socket = socket;

    socket.onopen = () => {
      this.#backoffMs = 500;
      this.#lastMessageAt = Date.now();
      this.onLink("live");
      if (this.#watching) socket.send(JSON.stringify({ type: "watch", paneId: this.#watching }));
    };
    socket.onmessage = (event) => {
      this.#lastMessageAt = Date.now();
      try {
        const message = JSON.parse(String(event.data)) as SocketMessage;
        // The heartbeat's only job is the timestamp above.
        if (message.type !== "ping") this.onMessage(message);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    };
    socket.onclose = () => {
      this.onLink("lost");
      this.#retry();
    };
    socket.onerror = () => socket.close();
  }

  #retry(): void {
    if (this.#closed || this.#timer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 10_000);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }
}
