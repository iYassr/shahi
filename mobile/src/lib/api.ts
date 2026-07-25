/**
 * Client for the HerdrUI server, for React Native.
 *
 * Every wire type comes from `@herdrui/shared`, the same module the web client
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
} from "@herdrui/shared";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export interface Connection {
  /** e.g. `http://ubuntu.tailnet01.ts.net:7171` */
  baseUrl: string;
  /** `herdrui_session=…`, held here because there is no browser cookie jar. */
  cookie: string | null;
}

/**
 * Mutable so the socket and every request see the same credentials without
 * threading them through each call site.
 */
export const connection: Connection = { baseUrl: "", cookie: null };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!connection.baseUrl) throw new Error("No server address configured");

  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (connection.cookie) headers.cookie = connection.cookie;

  const res = await fetch(`${connection.baseUrl}${path}`, { ...init, headers });
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
    const res = await fetch(`${connection.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (!res.ok) throw new Error("That passcode did not work.");
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

  upload: async (file: { uri: string; name: string; type: string }): Promise<StoredUpload> => {
    const body = new FormData();
    // React Native's FormData takes this shape rather than a File.
    body.append("file", { uri: file.uri, name: file.name, type: file.type } as never);
    const res = await fetch(`${connection.baseUrl}/api/uploads`, {
      method: "POST",
      headers: connection.cookie ? { cookie: connection.cookie } : {},
      body,
    });
    const payload = (await res.json().catch(() => ({}))) as StoredUpload & { error?: string };
    if (!res.ok || !payload.path) throw new Error(payload.error ?? "upload failed");
    return payload;
  },
};

/** See `api.send`. Measured against a live codex pane: 150ms sufficed. */
const SUBMIT_DELAY_MS = 200;

/* -------------------------------------------------------------------------- */

export type LinkState = "connecting" | "live" | "lost";

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
  #closed = false;
  #watching: string | null = null;

  constructor(
    private readonly onMessage: (msg: SocketMessage) => void,
    private readonly onLink: (state: LinkState) => void,
  ) {}

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = undefined;
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
      this.onLink("live");
      if (this.#watching) socket.send(JSON.stringify({ type: "watch", paneId: this.#watching }));
    };
    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as SocketMessage);
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
