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
import {
  SHAHI_API_VERSION,
  type ClaimResult,
  type DeviceList,
  type DirListing,
  type InstalledAgent,
  type PairedDevice,
  RELAY_LIMITS,
  type PaneFrame,
  type PromptOption,
  type PromptReceipt,
  type ServerInfo,
  type Session,
  type SessionLog,
  type SocketMessage,
  type StoredUpload,
} from "@shahi/shared";

import {
  IncompatibleServerError,
  UnauthorizedError,
  UnreachableError,
  hostOf,
  type UnreachableReason,
} from "./errors";
import { relayLink, toBase64Url, type LinkState, type LinkSubscriber, type RelayLink, type RelayTarget, type Reply, humanSize } from "./relay";

// The screens import the error classes from here; they moved to `errors.ts`
// so the relay transport can throw them without importing this module.
export { IncompatibleServerError, UnauthorizedError, UnreachableError, type UnreachableReason };

/**
 * Turns a `fetch` rejection into an `UnreachableError`.
 *
 * A rejected fetch — as opposed to a response with a bad status — means the
 * bytes never made it, so the only question is why, and the only evidence is
 * the platform's own words: NSURLError descriptions on iOS, OkHttp's on
 * Android, errno codes under Node and Bun (the tests, and `cause.code` when
 * it is there). Anything unrecognised keeps the platform's description,
 * trimmed of the wrapper, so an unknown failure stays diagnosable — it is
 * just not dressed up as a known one.
 */
export function describeTransportFailure(e: unknown, url: string, timeoutMs = REQUEST_TIMEOUT_MS): UnreachableError {
  if (e instanceof UnreachableError) return e;
  const host = hostOf(url);
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined;

  if (err?.name === "AbortError") {
    return new UnreachableError(
      "timeout",
      host,
      `${host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds. It may be asleep, down, or behind a firewall that drops this port.`,
    );
  }

  // The description is the useful part of Expo's message; the rest is where it
  // was thrown, which helps nobody holding a phone. The shape was copied from a
  // simulator log — "fetch failed: UnexpectedException: <description>. (at
  // ExpoModulesCore/Promise.swift:56)" — and the first draft, written from a
  // hand-typed report of it, matched neither the CamelCase nor the brackets.
  const detail = String(err?.message ?? e ?? "")
    .replace(/^(TypeError: )?fetch failed(: unexpected ?exception)?:?\s*/i, "")
    .replace(/\s*\(?at ExpoModulesCore\/[^)\s]+\)?/i, "")
    .trim()
    .replace(/\.$/, "");
  const said = `${detail} ${err?.code ?? ""} ${err?.cause?.code ?? ""}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => said.includes(n));

  if (has("invalid url", "unsupported url", "only absolute urls", "err_invalid_url")) {
    return new UnreachableError("address", host, `"${url}" isn't a full address. It needs to start with http:// or https://.`);
  }
  // App Transport Security: iOS refused a plain http:// URL before trying it.
  // Seen on a simulator build whose native project predated the
  // `NSAllowsArbitraryLoads` entry in app.json — and it says "secure
  // connection", so without this branch it read as a certificate problem.
  if (has("app transport security")) {
    return new UnreachableError(
      "ats",
      host,
      `This build of the app only allows https:// connections, so ${host} was refused before it was tried. Use https://, or rebuild the app from the current app.json, which allows http.`,
    );
  }
  if (has("hostname could not be found", "unable to resolve host", "enotfound", "eai_again", "nodename nor servname", "name or service not known")) {
    return new UnreachableError(
      "dns",
      host,
      `Couldn't find ${host}. Check the address — and if it's a tailnet name, that Tailscale is connected on this phone.`,
    );
  }
  if (has("appears to be offline", "network is unreachable", "enetunreach", "enetdown", "no internet")) {
    return new UnreachableError("offline", host, "This phone is offline. Check Wi‑Fi or mobile data, then try again.");
  }
  if (has("connection refused", "could not connect to the server", "econnrefused", "failed to connect to", "unable to connect")) {
    return new UnreachableError(
      "refused",
      host,
      `Nothing answered at ${host}. Check that the Shahi server is running there and that the port is right.`,
    );
  }
  if (has("connection was lost", "econnreset", "socket hang up", "connection abort", "epipe")) {
    return new UnreachableError("lost", host, `The connection to ${host} dropped mid-request. Try again.`);
  }
  if (has("ssl", "tls", "certificate", "secure connection", "handshake")) {
    return new UnreachableError(
      "tls",
      host,
      `Couldn't make a secure connection to ${host}. If the server has no TLS, use http://; if it does, check its certificate.`,
    );
  }
  return new UnreachableError("unknown", host, detail ? `Couldn't reach ${host} (${detail}).` : `Couldn't reach ${host}.`);
}

export interface Connection {
  /** e.g. `http://ubuntu.tailnet01.ts.net:7171` */
  baseUrl: string;
  /** `shahi_session=…`, held here because there is no browser cookie jar. */
  cookie: string | null;
  /**
   * Set when the box is reached through a blind relay (`lib/relay`): every
   * request and the socket then travel inside sealed frames on one link,
   * and `baseUrl` and `cookie` are unused — the link is the session.
   */
  relay: RelayTarget | null;
}

/**
 * Mutable so the socket and every request see the same credentials without
 * threading them through each call site.
 */
export const connection: Connection = { baseUrl: "", cookie: null, relay: null };

/** Something to talk to, of either kind. */
const configured = () => !!connection.relay || !!connection.baseUrl;

/**
 * How long any single request may hang before it is aborted. A dead host used
 * to leave Connect or an action busy forever, because `fetch` has no timeout of
 * its own; this bounds it and surfaces an `UnreachableError` the UI can recover
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
    throw describeTransportFailure(e, url, ms);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What every request carries: the contract version this build speaks, and the
 * session cookie when there is one. One place, so no route can forget the
 * version header and slip past the server's compatibility check.
 */
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "x-shahi-api": String(SHAHI_API_VERSION), ...extra };
  if (connection.cookie) headers.cookie = connection.cookie;
  return headers;
}

/**
 * How a request travels: over HTTP to the address, or through the relay link.
 *
 * The one place that decides, so every route builds the same method, path,
 * headers and body regardless — the version header included — and a relay
 * request is indistinguishable to the code that reads the answer. The relay
 * gets bytes rather than a `RequestInit`: there is no fetch behind it to
 * understand strings and `FormData`.
 */
async function dispatch(
  path: string,
  init: { method?: string; headers: Record<string, string>; body?: string | Uint8Array },
  ms = REQUEST_TIMEOUT_MS,
): Promise<Reply> {
  if (connection.relay) {
    const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : (init.body ?? null);
    return relayLink(connection.relay).request({ method: init.method ?? "GET", path, headers: init.headers, body }, ms);
  }
  // `credentials: "omit"` turns off the native cookie jar for this request. On
  // iOS, NSURLSession manages cookies itself and overrides a manually-set
  // `cookie` header with whatever its jar holds — observed live: login returns
  // 200 and sets the cookie, the next request 401s with the header
  // demonstrably set, and the resulting UnauthorizedError signs the app out
  // again. This client owns its cookie, because there is no browser to own it;
  // the jar must not compete for the job.
  // Every API response is live state. NSURLSession may otherwise satisfy a
  // cold-start GET from its disk cache after the sidecar has been upgraded,
  // which leaves an old session on screen and hides the new server's 426.
  // The server also sends no-store, but declaring it here protects the client
  // from proxies and test servers that forget that header.
  return fetchWithTimeout(
    `${connection.baseUrl}${path}`,
    { ...init, credentials: "omit", cache: "no-store" } as RequestInit,
    ms,
  );
}

/** A 426 is the server declining this contract version; say so, in its words. */
async function incompatible(res: Reply): Promise<IncompatibleServerError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; api?: { min: number; max: number } };
  return new IncompatibleServerError(
    body.error ?? "This app and the Shahi server do not speak the same version.",
    body.api ?? { min: 0, max: 0 },
  );
}

async function request<T>(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  if (!configured()) throw new Error("No server address configured");

  const res = await dispatch(path, { ...init, headers: baseHeaders(init.headers) });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 426) throw await incompatible(res);
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

/**
 * The last transcript body and its ETag, per polled path.
 *
 * The reader polls `sessionLog` every 2.5s forever, and an unchanged
 * conversation is most polls. The server already tags each response and
 * answers a matching `if-none-match` with a bodiless 304 — but only a browser
 * revalidates on its own. This native client never sent the tag, so it
 * re-downloaded the whole transcript every poll; over the relay, which carries
 * no HTTP cache and no compression, that was the full uncompressed JSON in a
 * sealed frame every 2.5s. Sending the tag turns an unchanged poll into a 304
 * (measured on the web client: 224 bytes against 15KB gzipped). The kept body
 * is returned unchanged on a 304, so the reader's `merge` sees no difference.
 */
const transcriptCache = new Map<string, { etag: string; value: SessionLog }>();

export const api = {
  authStatus: () => request<{ required: boolean; authenticated: boolean }>("/api/auth/status"),

  /**
   * The handshake: what is at this address, and can this build talk to it.
   *
   * Asked before login, so a typo that lands on some other web server is
   * reported as "not a Shahi server" rather than as a wrong passcode, and a
   * version gap is reported as which side to update rather than as whatever
   * route happens to fail first.
   */
  meta: async (): Promise<ServerInfo> => {
    if (!configured()) throw new Error("No server address configured");
    const res = await dispatch("/api/meta", { headers: { "x-shahi-api": String(SHAHI_API_VERSION) } });
    if (res.status === 426) throw await incompatible(res);
    const info = (await res.json().catch(() => null)) as ServerInfo | null;
    const api = info?.api;
    if (!res.ok || typeof api?.min !== "number" || typeof api?.max !== "number") {
      throw new Error("That address answered, but it isn't a Shahi server.");
    }
    if (api.max < SHAHI_API_VERSION) {
      throw new IncompatibleServerError(
        "This server runs an older Shahi than the app. Update Shahi on that computer — run herdr plugin install iYassr/shahi again.",
        api,
      );
    }
    if (api.min > SHAHI_API_VERSION) {
      throw new IncompatibleServerError(
        "This app is older than the Shahi on that server. Update the app.",
        api,
      );
    }
    return info as ServerInfo;
  },

  /** Captures the session cookie, since there is no browser to hold it. */
  login: async (passcode: string) => {
    // The response cookie stays out of the native jar (see `dispatch`): this
    // client stores it itself, and a jar copy would then fight the header.
    const res = await dispatch("/api/auth/login", {
      method: "POST",
      headers: baseHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ passcode }),
    });
    // Only a 401 is actually a bad passcode. A 502/503/504 means the address is
    // reached but the sidecar behind it is not (e.g. a `tailscale serve` proxy
    // pointing at the wrong port) — calling that "wrong passcode" sent people
    // hunting for the wrong problem.
    if (res.status === 401) throw new Error("That passcode did not work.");
    if (res.status === 426) throw await incompatible(res);
    if (!res.ok)
      throw new Error(
        `Reached the address but not the server (HTTP ${res.status}). Check that the sidecar is running and that any TLS proxy points at it.`,
      );
    connection.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] || null;
    if (!connection.cookie) throw new Error("Server did not return a session");
    return connection.cookie;
  },

  /**
   * Redeems a scanned pairing code for a session bound to this phone.
   *
   * Shaped like `login` rather than `request`, for the same reasons: the
   * cookie in the answer is the point, and a 401 here means a spent or expired
   * code — not a signed-out session, which is what `request` would make of it.
   */
  claimPairing: async (secret: string, deviceName: string): Promise<PairedDevice> => {
    const res = await dispatch("/api/pair/claim", {
      method: "POST",
      headers: baseHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ secret, deviceName }),
    });
    if (res.status === 426) throw await incompatible(res);
    const body = (await res.json().catch(() => ({}))) as { device?: PairedDevice; error?: string };
    if (res.status === 401) throw new Error(body.error ?? "That pairing code is not valid.");
    if (!res.ok || !body.device) {
      throw new Error(
        `Reached the address but not the server (HTTP ${res.status}). Check that the sidecar is running and that any TLS proxy points at it.`,
      );
    }
    connection.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] || null;
    if (!connection.cookie) throw new Error("Server did not return a session");
    return body.device;
  },

  /**
   * The same claim, over a relay link opened with the pairing secret.
   *
   * There is no cookie to keep: a relay link *is* its device, so what comes
   * back is the identity to reconnect with — a device id and the secret the
   * box will key that device's frames from. `connection.relay` must be a
   * pairing target when this is called; the caller stores the result and
   * reconnects as a device.
   */
  claimRelayPairing: async (secret: string, deviceName: string): Promise<ClaimResult> => {
    const res = await dispatch("/api/pair/claim", {
      method: "POST",
      headers: baseHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ secret, deviceName }),
    });
    if (res.status === 426) throw await incompatible(res);
    const body = (await res.json().catch(() => ({}))) as Partial<ClaimResult> & { error?: string };
    if (res.status === 401) throw new Error(body.error ?? "That pairing code is not valid.");
    if (!res.ok || !body.deviceId || !body.deviceSecret) {
      throw new Error(body.error ?? `The box answered the claim with HTTP ${res.status} and no device.`);
    }
    return { ok: true, deviceId: body.deviceId, deviceSecret: body.deviceSecret };
  },

  /** Phones that paired by scanning a code. A passcode login is not among them. */
  devices: () => request<DeviceList>("/api/devices"),

  /** Throws a paired phone out: its very next request is refused. */
  revokeDevice: (id: string) =>
    request<{ ok: boolean }>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),

  session: () => request<Session>("/api/session"),

  pane: (paneId: string) =>
    request<{ frame: PaneFrame | null; layout: { area: { width: number; height: number } } | null }>(
      `/api/panes/${encodeURIComponent(paneId)}`,
    ),

  sessionLog: async (paneId: string, limit = 60): Promise<SessionLog> => {
    if (!configured()) throw new Error("No server address configured");
    const path = `/api/panes/${encodeURIComponent(paneId)}/session?limit=${limit}`;
    const cached = transcriptCache.get(path);
    // Offer the tag when there is one; the server answers 304 if the
    // conversation has not moved. `if-none-match` is forwarded intact over the
    // relay (it is not among the headers a link may not set), so the same
    // revalidation works on both transports.
    const res = await dispatch(path, { headers: baseHeaders(cached ? { "if-none-match": cached.etag } : {}) });
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 426) throw await incompatible(res);
    if (res.status === 304 && cached) return cached.value;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${path} failed with ${res.status}`);
    }
    const value = (await res.json()) as SessionLog;
    const etag = res.headers.get("etag");
    if (etag) transcriptCache.set(path, { etag, value });
    else transcriptCache.delete(path);
    return value;
  },

  agents: () => request<{ agents: InstalledAgent[]; known: number }>("/api/agents"),

  dirs: (path = "~", files = false) =>
    request<DirListing>(`/api/dirs?path=${encodeURIComponent(path)}${files ? "&files=1" : ""}`),

  /**
   * Makes a space. The server owns the herdr call; the phone only says what it
   * wants. Absolute `cwd` only: herdr does not expand `~`, it silently uses
   * $HOME — and the server refuses a relative path rather than guessing.
   */
  createWorkspace: (options: { label: string | null; cwd: string | null }) =>
    postJson<{ workspaceId: string }>("/api/workspaces", options),

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
    if (!configured()) throw new Error("No server address configured");
    const route = `/api/file?path=${encodeURIComponent(path)}`;
    // Through the timeout like every other request: a raw fetch here hung
    // the file viewer forever on a dead host (data-fetching audit).
    const res = await dispatch(route, { headers: baseHeaders() });
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 426) throw await incompatible(res);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `could not read that file (${res.status})`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("image/")) {
      // Over HTTP the URL is handed back rather than the bytes: `Image` fetches
      // it itself, and passing megabytes of base64 through JS to get there
      // would be worse. Over the relay there is no URL an `Image` could fetch —
      // the bytes only exist inside a sealed frame — so they are handed over as
      // a data URL, which is the one form of "here are the bytes" it accepts.
      if (!connection.relay) return { imageUrl: `${connection.baseUrl}${route}` };
      const base64 = toBase64Url(await res.bytes()).replace(/-/g, "+").replace(/_/g, "/");
      return { imageUrl: `data:${type.split(";")[0]};base64,${base64}` };
    }
    return { text: await res.text() };
  },

  /**
   * Answers a prompt card by posting the option as it was shown. The server
   * re-reads the screen and presses the keys: a digit for a numbered menu,
   * cursor moves and Enter for an unnumbered one (Claude Code's folder-trust
   * question, where a digit does nothing). A 409 means the question has gone
   * or changed under the card; the next poll redraws it.
   */
  answerPrompt: (paneId: string, option: Pick<PromptOption, "index" | "label">) =>
    postJson<{ ok: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/answer`, {
      index: option.index,
      label: option.label,
    }),

  /**
   * Sends a message: one request, and a receipt that says herdr has it.
   *
   * This used to be two requests with a 200ms pause between them (text, then
   * Enter — codex's composer needs a moment to ingest inserted text before
   * Enter counts as submit). That pause and the choice between herdr's semantic
   * `agent.prompt` and the raw terminal sequence now live in the server, which
   * knows what the pane is; the phone knows only that it said something.
   *
   * `clientMessageId` lets a retry after a timeout be recognised as the same
   * message, so a bad connection cannot deliver a prompt twice.
   */
  send: (paneId: string, text: string) =>
    postJson<PromptReceipt>(`/api/panes/${encodeURIComponent(paneId)}/prompt`, {
      text,
      clientMessageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    }),

  /** Key presses — Escape, arrows, a digit for a numbered prompt. */
  sendKeys: (paneId: string, keys: string[]) =>
    postJson<{ ok: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/keys`, { keys }),

  /** Registers this device for notifications. See `lib/push`. */
  registerPush: (token: string) => postJson<{ ok: boolean }>("/api/push/expo", { token }),

  unregisterPush: (token: string) =>
    postJson<{ ok: boolean }>("/api/push/expo/unsubscribe", { token }),

  upload: async (file: { uri: string; name: string; type: string }): Promise<StoredUpload> => {
    // A photo over a slow tailnet needs longer than the default 15s, but still
    // a bound: a raw fetch here hung forever on a dead host (data-fetching audit).
    const res = connection.relay
      ? await dispatch("/api/uploads", tooBigForRelay(await multipart(file)), 60_000)
      : await (async () => {
          const body = new FormData();
          // React Native's FormData takes this shape rather than a File.
          body.append("file", { uri: file.uri, name: file.name, type: file.type } as never);
          return fetchWithTimeout(
            `${connection.baseUrl}/api/uploads`,
            { method: "POST", headers: baseHeaders(), body, credentials: "omit" }, // see `dispatch`
            60_000,
          );
        })();
    if (res.status === 426) throw await incompatible(res);
    const payload = (await res.json().catch(() => ({}))) as StoredUpload & { error?: string };
    if (!res.ok || !payload.path) throw new Error(payload.error ?? "upload failed");
    return payload;
  },
};

/**
 * A relay request is one sealed frame and the relay closes the link on one
 * over its cap — which the app reported as "the relay is throttling this
 * phone" and which retrying repeated (measured: every iPhone photo is over
 * it). Refused here, before anything is sent, with the number.
 */
function tooBigForRelay<T extends { body: Uint8Array }>(request: T): T {
  if (request.body.length <= RELAY_LIMITS.maxBodyBytes) return request;
  throw new Error(
    `This file is ${humanSize(request.body.length)} and the relay carries up to ${humanSize(RELAY_LIMITS.maxBodyBytes)} in one message. ` +
      "On the same network as the box, connect directly to send it.",
  );
}

/**
 * The multipart body `FormData` would have built, as bytes, for the relay.
 *
 * There is no fetch behind a relay request to read a `file://` URI and frame
 * it, so the file is read here — `fetch` on the URI is how React Native reads
 * local files without another module — and framed by hand. The box parses it
 * with the same `formData()` the HTTP route uses; nothing server-side knows
 * the difference.
 */
async function multipart(file: {
  uri: string;
  name: string;
  type: string;
}): Promise<{ method: string; headers: Record<string, string>; body: Uint8Array }> {
  const bytes = new Uint8Array(await (await fetch(file.uri)).arrayBuffer());
  const boundary = `shahi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/["\r\n]/g, "_")}"\r\n` +
      `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return {
    method: "POST",
    headers: baseHeaders({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body,
  };
}

/* -------------------------------------------------------------------------- */

export type { LinkState };

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
  // Through a relay the stream arrives on the same link the requests use, so
  // there is nothing to open here: this socket subscribes to that link and
  // forwards the same three callbacks. Everything above sees one socket.
  #relay: RelayLink | undefined;
  readonly #subscriber: LinkSubscriber = {
    onMessage: (msg) => this.onMessage(msg),
    onLink: (state) => {
      this.onLink(state);
      if (state === "lost" && !this.#closed) this.onDisconnected?.();
    },
    onExpired: () => {
      this.close();
      this.onExpired?.();
    },
  };

  constructor(
    private readonly onMessage: (msg: SocketMessage) => void,
    private readonly onLink: (state: LinkState) => void,
    /** The server closed with 4001: the session no longer verifies. */
    private readonly onExpired?: () => void,
    /** Re-check HTTP when a link dies; a rejected WS handshake hides its 426. */
    private readonly onDisconnected?: () => void,
  ) {}

  connect(): void {
    this.#closed = false;
    if (connection.relay) {
      this.#attachRelay(connection.relay);
      return;
    }
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
    // The link itself stays: requests still need it. It goes with sign-out.
    this.#relay?.unsubscribe(this.#subscriber);
    this.#relay = undefined;
  }

  /** Reconnects now if the connection is not up — for coming back to the app. */
  ensureConnected(): void {
    // Closed on purpose (a 426, say) is re-openable: "Try again" lands here.
    if (this.#closed) {
      this.connect();
      return;
    }
    if (connection.relay) {
      this.#attachRelay(connection.relay);
      return;
    }
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
    if (this.#relay) {
      this.#relay.watch(paneId);
      return;
    }
    if (this.#socket?.readyState !== 1) return;
    this.#socket.send(JSON.stringify(paneId ? { type: "watch", paneId } : { type: "unwatch" }));
  }

  /** Follows the link for the current target, re-subscribing if pairing or sign-in replaced it. */
  #attachRelay(target: RelayTarget): void {
    const link = relayLink(target);
    if (this.#relay !== link) {
      this.#relay?.unsubscribe(this.#subscriber);
      this.#relay = link;
      link.subscribe(this.#subscriber);
    }
    link.ensureConnected();
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

    // The contract version rides on the handshake too, through `baseHeaders`
    // like every request. Without it a server that had just refused this
    // build with a 426 still upgraded the socket and pushed a session — so
    // "Update needed" was on screen for a moment and then replaced by a live
    // list from a server the app cannot otherwise talk to. Found writing the
    // update-needed flow, where that state could not be held long enough to
    // assert on.
    const socket = new RNWebSocket(`${url}/ws`, undefined, { headers: baseHeaders() });
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
    socket.onclose = (event: { code?: number }) => {
      this.onLink("lost");
      // 4001 is the server's heartbeat finding this session expired or
      // revoked. Retrying would be refused at the gate forever, and React
      // Native surfaces that refusal as another close, never as a 401.
      if (event?.code === 4001) {
        this.close();
        this.onExpired?.();
        return;
      }
      if (!this.#closed) this.onDisconnected?.();
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
