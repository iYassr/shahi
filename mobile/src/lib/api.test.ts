import { api, connection } from "./api";

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
