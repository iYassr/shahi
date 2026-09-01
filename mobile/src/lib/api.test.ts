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

  test("answering a numbered prompt presses its digit", async () => {
    ok({ ok: true });
    await api.answerPrompt("w1:p1", 2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:7272/api/panes/w1%3Ap1/keys");
    expect(JSON.parse(init.body)).toEqual({ keys: ["2"] });
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
      expect(call[1].headers["x-shahi-api"]).toBe("1");
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
    expect(opened[0]![2]).toEqual({ headers: { "x-shahi-api": "1", cookie: "shahi_session=x" } });
  });

  // 426 is the server declining this version, not a generic failure: the
  // message names which side to update.
  test("a 426 is an incompatible server, in the server's words", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 426,
      headers: new Headers(),
      json: async () => ({ error: "Update Shahi on this computer.", api: { min: 2, max: 2 } }),
    });
    await expect(api.session()).rejects.toBeInstanceOf(IncompatibleServerError);
    await expect(api.session()).rejects.toThrow("Update Shahi on this computer.");
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
    answer(200, info(1, 1));
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
    answer(200, info(0, 0));
    const e = await api.meta().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(IncompatibleServerError);
    expect((e as Error).message).toMatch(/Update Shahi on that computer/);
  });

  test("a server ahead of this app says to update the app", async () => {
    answer(200, info(2, 3));
    const e = await api.meta().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(IncompatibleServerError);
    expect((e as Error).message).toMatch(/Update the app/);
  });
});
