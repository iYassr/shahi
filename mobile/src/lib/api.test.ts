import { SHAHI_API_VERSION } from "@shahi/shared";
import { api, connection, fetchWithTimeout, IncompatibleServerError, SessionSocket, UnreachableError } from "./api";

/**
 * The client's own decisions, below the screens.
 *
 * `readFile` is the one with a branch in it — text and images arrive down the
 * same route and are told apart by content-type, because the server is what
 * decides that. Getting it wrong renders a PNG as mojibake.
 */
describe("readFile", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    connection.baseUrl = "http://localhost:7272";
    connection.cookie = "shahi_session=x";
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  const reply = (contentType: string, body = "hello") =>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": contentType }),
      text: async () => body,
    });

  test("text comes back as text", async () => {
    reply("text/plain; charset=utf-8", "const x = 1;");
    await expect(api.readFile("/home/y/x.ts")).resolves.toEqual({ text: "const x = 1;" });
  });

  // The URL is handed back rather than the bytes: `Image` fetches it itself,
  // and passing megabytes of base64 through JS to get there would be worse.
  test("an image comes back as a URL, not as bytes", async () => {
    reply("image/png");
    const result = await api.readFile("/home/y/shot.png");
    expect(result).toHaveProperty("imageUrl");
    expect((result as { imageUrl: string }).imageUrl).toContain("shot.png");
  });

  // HTML is served as text/plain by the server so agent-written markup cannot
  // run anywhere. The client must not second-guess that by sniffing the name.
  test("html is text, because the server said so", async () => {
    reply("text/plain; charset=utf-8", "<script>alert(1)</script>");
    const result = await api.readFile("/home/y/page.html");
    expect(result).toHaveProperty("text");
  });

  test("the path is encoded, so a space or a colon survives", async () => {
    reply("text/plain");
    await api.readFile("/home/y/my notes/w4:p1.txt");
    expect(fetchMock.mock.calls[0]![0]).toContain(encodeURIComponent("/home/y/my notes/w4:p1.txt"));
  });

  // The cookie belongs to this client because there is no browser to own it;
  // NSURLSession's jar competes for the job and wins if allowed to.
  test("sends its own cookie and refuses the native jar", async () => {
    reply("text/plain");
    await api.readFile("/home/y/x.ts");
    const init = fetchMock.mock.calls[0]![1];
    expect(init.credentials).toBe("omit");
    expect(init.headers.cookie).toBe("shahi_session=x");
  });

  test("a refusal says why rather than returning nothing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ error: "outside the readable roots" }),
    });
    await expect(api.readFile("/etc/passwd")).rejects.toThrow("outside the readable roots");
  });
});

/**
 * What a server that cannot be reached looks like to the person holding the
 * phone.
 *
 * `fetch` rejects with the platform's own words — on iOS, Expo wraps an
 * NSURLError description as "fetch failed: unexpected exception: … at
 * ExpoModulesCore/Promise.swift:56" — and that string was reaching the screen
 * verbatim. The messages here are the real ones, copied from the device and
 * from Node, because the classifier is a list of things platforms say.
 */
describe("when the server cannot be reached", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    connection.baseUrl = "http://ubuntu.tailnet.ts.net:7171";
    connection.cookie = "shahi_session=x";
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  // The exact shape a simulator logged, brackets and CamelCase included; the
  // first classifier was written from a hand-typed report and matched neither.
  const expo = (description: string) =>
    new Error(`fetch failed: UnexpectedException: ${description} (at ExpoModulesCore/Promise.swift:56)`);

  const failing = async (): Promise<UnreachableError> => {
    try {
      await api.session();
    } catch (e) {
      return e as UnreachableError;
    }
    throw new Error("expected api.session to reject");
  };

  test("a hostname that does not resolve names the host and never the Swift file", async () => {
    fetchMock.mockRejectedValue(expo("A server with the specified hostname could not be found."));
    const e = await failing();
    expect(e).toBeInstanceOf(UnreachableError);
    expect(e.reason).toBe("dns");
    expect(e.message).toContain("Couldn't find ubuntu.tailnet.ts.net:7171");
    expect(e.message).not.toMatch(/Promise\.swift|unexpected exception|fetch failed/);
  });

  test("a closed port says nothing is listening there", async () => {
    fetchMock.mockRejectedValue(expo("Could not connect to the server."));
    const e = await failing();
    expect(e.reason).toBe("refused");
    expect(e.message).toContain("Nothing answered at ubuntu.tailnet.ts.net:7171");
  });

  test("no network at all blames the phone, not the server", async () => {
    fetchMock.mockRejectedValue(expo("The Internet connection appears to be offline."));
    const e = await failing();
    expect(e.reason).toBe("offline");
    expect(e.message).toMatch(/This phone is offline/);
  });

  // Measured on a simulator build whose native project predated the ATS
  // exception in app.json: the message says "secure connection", and the first
  // draft filed it under TLS, which sent the reader to check a certificate.
  test("App Transport Security is named as the build's rule, not a certificate", async () => {
    fetchMock.mockRejectedValue(
      expo("The resource could not be loaded because the App Transport Security policy requires the use of a secure connection."),
    );
    const e = await failing();
    expect(e.reason).toBe("ats");
    expect(e.message).toMatch(/only allows https/);
    expect(e.message).not.toMatch(/certificate/);
  });

  test("a TLS failure suggests the scheme, since http is the common fix", async () => {
    fetchMock.mockRejectedValue(
      expo("An SSL error has occurred and a secure connection to the server cannot be made."),
    );
    const e = await failing();
    expect(e.reason).toBe("tls");
    expect(e.message).toContain("http://");
  });

  // Node and Bun put the reason on `cause.code`, not in the message. The test
  // runner is one such platform, so this is also what keeps the suite honest.
  test("an errno on the cause is understood too", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    const e = await failing();
    expect(e.reason).toBe("refused");
  });

  test("the timeout says how long it waited", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => {
            const e = new Error("Aborted");
            e.name = "AbortError";
            reject(e);
          }),
        ),
    );
    await expect(fetchWithTimeout("http://ubuntu.tailnet.ts.net:7171/api/session", {}, 20)).rejects.toMatchObject({
      reason: "timeout",
      message: expect.stringContaining("didn't answer within 0 seconds"),
    });
  });

  // Unknown shapes are described, not guessed at: the platform's words stay,
  // the wrapper goes.
  test("an unrecognised failure keeps the platform's description, trimmed", async () => {
    fetchMock.mockRejectedValue(expo("Something nobody has seen before."));
    const e = await failing();
    expect(e.reason).toBe("unknown");
    expect(e.message).toBe("Couldn't reach ubuntu.tailnet.ts.net:7171 (Something nobody has seen before).");
  });

  test("an address with no scheme is called out as such", async () => {
    connection.baseUrl = "ubuntu.tailnet.ts.net:7171";
    fetchMock.mockRejectedValue(new TypeError("Invalid URL"));
    const e = await failing();
    expect(e.reason).toBe("address");
    expect(e.message).toContain("http://");
  });

  // Login is a separate fetch from `request`, and the Connect screen is where
  // the raw string was first reported — so it is checked on its own.
  test("signing in to an unreachable host gets the same words", async () => {
    fetchMock.mockRejectedValue(expo("A server with the specified hostname could not be found."));
    await expect(api.login("1234")).rejects.toThrow("Couldn't find ubuntu.tailnet.ts.net:7171");
  });

  // Reached-and-refusing is a different thing from unreachable, and the
  // server's own explanation must survive rather than be replaced by ours.
  test("a server that answered with an error is not dressed up as unreachable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ error: "herdr socket not found" }),
    });
    const e = await failing();
    expect(e).not.toBeInstanceOf(UnreachableError);
    expect(e.message).toBe("herdr socket not found");
  });
});

/**
 * The phone speaks Shahi's API, not herdr's.
 *
 * A prompt used to be two raw RPCs with a pause between them, which meant the
 * phone knew herdr method names and owned a codex-specific timing. Now it says
 * what it wants — one request per intent — and the server decides how herdr
 * hears it. These pin that: one request, the right route, and nothing ever
 * shaped like `/api/rpc` again.
 */
describe("semantic requests", () => {
  const fetchMock = jest.fn();
  const ok = (body: unknown) =>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    });

  beforeEach(() => {
    connection.baseUrl = "http://localhost:7272";
    connection.cookie = "shahi_session=x";
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  test("a prompt is one request, with a client message id, and never /api/rpc", async () => {
    ok({ accepted: true, clientMessageId: "x", acceptedAt: 1 });
    await api.send("w1:p1", "run the tests");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:7272/api/panes/w1%3Ap1/prompt");
    expect(url).not.toContain("/api/rpc");
    const body = JSON.parse(init.body);
    expect(body.text).toBe("run the tests");
    expect(typeof body.clientMessageId).toBe("string");
    expect(body.clientMessageId.length).toBeGreaterThan(8);
  });

  test("answering a prompt posts the option, never a keystroke", async () => {
    ok({ ok: true });
    await api.answerPrompt("w1:p1", { index: 2, label: "Yes, I trust this folder" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:7272/api/panes/w1%3Ap1/answer");
    expect(JSON.parse(init.body)).toEqual({ index: 2, label: "Yes, I trust this folder" });
  });

  test("a new space is a workspace request", async () => {
    ok({ workspaceId: "w9" });
    await expect(api.createWorkspace({ label: "notes", cwd: "/home/y/notes" })).resolves.toEqual({
      workspaceId: "w9",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:7272/api/workspaces");
    expect(JSON.parse(init.body)).toEqual({ label: "notes", cwd: "/home/y/notes" });
  });

  test("every request says which contract version it speaks", async () => {
    ok({});
    await api.session();
    await api.sendKeys("w1:p1", ["Escape"]);
    await api.readFile("/home/y/x.ts").catch(() => undefined);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers["x-shahi-api"]).toBe(String(SHAHI_API_VERSION));
      expect(call[1].cache).toBe("no-store");
    }
  });

  // The socket is a request too. Left without the header, a server that had
  // just answered 426 still upgraded it and pushed a session over the top of
  // "Update needed".
  test("the socket handshake says which contract version it speaks, and carries the cookie", () => {
    const opened: unknown[][] = [];
    const realWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      constructor(...args: unknown[]) {
        opened.push(args);
      }
      close() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    try {
      const socket = new SessionSocket(jest.fn(), jest.fn());
      socket.connect();
      socket.close();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toBe("ws://localhost:7272/ws");
    expect(opened[0]![2]).toEqual({ headers: { "x-shahi-api": String(SHAHI_API_VERSION), cookie: "shahi_session=x" } });
  });

  test("a dropped socket asks the session layer to check HTTP for a hidden 426", () => {
    let opened: { onclose?: (event: { code?: number }) => void; close(): void } | undefined;
    const realWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      readyState = 0;
      onclose?: (event: { code?: number }) => void;
      constructor() { opened = this; }
      close() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const disconnected = jest.fn();
    try {
      const socket = new SessionSocket(jest.fn(), jest.fn(), jest.fn(), disconnected);
      socket.connect();
      opened!.onclose?.({ code: 1006 });
      socket.close();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  // 426 is the server declining this version, not a generic failure: the
  // message names which side to update.
  test("a 426 is an incompatible server, in the server's words", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 426,
      headers: new Headers(),
      json: async () => ({ error: "Update Shahi on this computer.", api: { min: SHAHI_API_VERSION + 1, max: SHAHI_API_VERSION + 1 } }),
    });
    await expect(api.session()).rejects.toBeInstanceOf(IncompatibleServerError);
    await expect(api.session()).rejects.toThrow("Update Shahi on this computer.");
  });
});

/**
 * The reader's transcript poll, which runs every 2.5s forever.
 *
 * The server tags each response and answers a matching `if-none-match` with a
 * bodiless 304, but only a browser revalidates on its own — this client never
 * sent the tag, so every poll re-downloaded the whole conversation. These pin
 * that it now offers the tag and treats a 304 as unchanged without a body.
 */
describe("transcript revalidation", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    connection.baseUrl = "http://localhost:7272";
    connection.cookie = "shahi_session=x";
    connection.relay = null;
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  test("sends no ETag first, then offers it and reads a 304 without a body", async () => {
    const body = { paneId: "w9:p9", messages: [{ id: "m1", role: "agent", text: "hi" }], total: 1 };
    const json304 = jest.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", etag: 'W/"abc"' }),
        json: async () => body,
      })
      .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers({ etag: 'W/"abc"' }), json: json304 });

    const first = await api.sessionLog("w9:p9", 60);
    expect(first).toEqual(body);
    // Nothing to revalidate on the first poll.
    expect(fetchMock.mock.calls[0]![1].headers["if-none-match"]).toBeUndefined();

    const second = await api.sessionLog("w9:p9", 60);
    // The tag it was given goes back, the server answers 304, and the same
    // conversation is returned from the kept body — json() is never touched.
    expect(fetchMock.mock.calls[1]![1].headers["if-none-match"]).toBe('W/"abc"');
    expect(second).toEqual(body);
    expect(json304).not.toHaveBeenCalled();
  });
});

/**
 * The handshake, asked before the passcode.
 *
 * Without it a typo that lands on some other web server, or a Shahi too old for
 * this app, shows up as "wrong passcode" — which sent people to the wrong
 * problem.
 */
describe("meta", () => {
  const fetchMock = jest.fn();
  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({
      ok: status < 400,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    });

  beforeEach(() => {
    connection.baseUrl = "http://localhost:7272";
    connection.cookie = null;
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  const info = (min: number, max: number) => ({
    serverId: "abc",
    serverVersion: "0.1.0",
    api: { min, max },
    herdr: { version: "0.8.2", protocol: 20 },
  });

  test("a matching server is described", async () => {
    answer(200, info(SHAHI_API_VERSION, SHAHI_API_VERSION));
    await expect(api.meta()).resolves.toMatchObject({ serverId: "abc", herdr: { protocol: 20 } });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:7272/api/meta");
  });

  test("something that answers but is not Shahi is called that", async () => {
    answer(200, { hello: "world" });
    await expect(api.meta()).rejects.toThrow("isn't a Shahi server");
  });

  test("a 404 from a stranger's server is also not Shahi", async () => {
    answer(404, { error: "not found" });
    await expect(api.meta()).rejects.toThrow("isn't a Shahi server");
  });

  test("a server behind this app says to update the computer", async () => {
    answer(200, info(SHAHI_API_VERSION - 1, SHAHI_API_VERSION - 1));
    const e = await api.meta().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(IncompatibleServerError);
    expect((e as Error).message).toMatch(/Update Shahi on that computer/);
  });

  test("a server ahead of this app says to update the app", async () => {
    answer(200, info(SHAHI_API_VERSION + 1, SHAHI_API_VERSION + 2));
    const e = await api.meta().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(IncompatibleServerError);
    expect((e as Error).message).toMatch(/Update the app/);
  });
});

/**
 * Pairing, from the phone's side: a scanned code becomes a session bound to
 * this device, and the device list is what Settings revokes from.
 */
describe("pairing", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    connection.baseUrl = "http://localhost:7272";
    connection.cookie = null;
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  test("the device list is read with the session, and a revoke is a DELETE of that device", async () => {
    connection.cookie = "shahi_session=x";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ devices: [], thisDeviceId: null }),
    });
    await expect(api.devices()).resolves.toEqual({ devices: [], thisDeviceId: null });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:7272/api/devices");
    expect(fetchMock.mock.calls[0]![1].headers.cookie).toBe("shahi_session=x");

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
    });
    await api.revokeDevice("dev/1");
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("http://localhost:7272/api/devices/dev%2F1");
    expect(init.method).toBe("DELETE");
  });
});

test("a cold agent startup can exceed the ordinary fifteen-second request timeout", async () => {
  jest.useFakeTimers();
  connection.baseUrl = "http://localhost:7272";
  connection.relay = null;
  const fetchMock = jest.fn((_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ paneId: "slow", tabId: "t1" }) }), 20_000);
  }));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  try {
    const response = api.startAgent({ clientRequestId: "stable-start", workspaceId: "w1", cwd: null, label: null, kind: "claude", name: "claude", mode: null });
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(response).resolves.toEqual({ paneId: "slow", tabId: "t1" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).clientRequestId).toBe("stable-start");
  } finally { jest.useRealTimers(); }
});

test("a login response arriving after cancellation cannot restore signed-out credentials", async () => {
  connection.baseUrl = "http://localhost:7272";
  connection.relay = null;
  connection.cookie = null;
  (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200, headers: new Headers({ "set-cookie": "shahi_session=late; HttpOnly" }),
  });
  await api.login("fake", () => false);
  expect(connection.cookie).toBeNull();
});
