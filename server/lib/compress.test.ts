import { beforeEach, describe, expect, test } from "bun:test";
import { compress, forgetCompressed, worthCompressing } from "./compress";

const request = (accept = "gzip, deflate, br") =>
  new Request("http://x/", { headers: { "accept-encoding": accept } });

const jsonResponse = (bytes: number) => {
  const body = JSON.stringify({ pad: "x".repeat(bytes) });
  return new Response(body, {
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });
};

beforeEach(forgetCompressed);

describe("worthCompressing", () => {
  test("takes text and JSON", () => {
    expect(worthCompressing("application/json", 5_000)).toBe(true);
    expect(worthCompressing("text/html; charset=utf-8", 5_000)).toBe(true);
    expect(worthCompressing("application/javascript", 5_000)).toBe(true);
  });

  test("leaves already-compressed formats alone", () => {
    expect(worthCompressing("image/png", 50_000)).toBe(false);
    expect(worthCompressing("font/woff2", 50_000)).toBe(false);
  });

  test("skips bodies too small to be worth the headers", () => {
    expect(worthCompressing("application/json", 200)).toBe(false);
  });
});

describe("compress", () => {
  test("shrinks a transcript-sized payload", async () => {
    const original = jsonResponse(45_000);
    const size = Number(original.headers.get("content-length"));

    const result = await compress(request(), original);
    expect(result.headers.get("content-encoding")).toBe("gzip");
    expect(Number(result.headers.get("content-length"))).toBeLessThan(size / 10);
  });

  test("tells caches the body depends on the request", async () => {
    const result = await compress(request(), jsonResponse(45_000));
    expect(result.headers.get("vary")).toContain("accept-encoding");
  });

  test("leaves a client that did not ask for it alone", async () => {
    const result = await compress(request("identity"), jsonResponse(45_000));
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(await result.text()).toContain("xxxx");
  });

  test("passes small bodies through with their content intact", async () => {
    const result = await compress(request(), jsonResponse(10));
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await result.text()).pad).toBe("xxxxxxxxxx");
  });

  test("never double-encodes", async () => {
    const already = new Response("already gzipped", {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect((await compress(request(), already)).headers.get("content-encoding")).toBe("gzip");
    expect(await already.text()).toBe("already gzipped");
  });

  test("leaves a 304 as a 304, with no body", async () => {
    const notModified = new Response(null, { status: 304 });
    const result = await compress(request(), notModified);
    expect(result.status).toBe(304);
  });

  test("gzips an immutable asset once and reuses it", async () => {
    const asset = () =>
      new Response("const x = 1;".repeat(2_000), {
        headers: {
          "content-type": "application/javascript",
          "content-length": String("const x = 1;".repeat(2_000).length),
        },
      });

    const first = await compress(request(), asset(), "app.abc12345.js");
    const second = await compress(request(), asset(), "app.abc12345.js");
    expect(second.headers.get("content-length")).toBe(first.headers.get("content-length"));

    // The point of the cache: identical bytes, without gzipping twice.
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
  });

  test("round-trips: what the client ungzips is what the route sent", async () => {
    const payload = { messages: Array.from({ length: 200 }, (_, i) => ({ id: i, text: "hello" })) };
    const body = JSON.stringify(payload);
    const original = new Response(body, {
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    });

    const result = await compress(request(), original);
    const inflated = Bun.gunzipSync(new Uint8Array(await result.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(inflated))).toEqual(payload);
  });
});
