import { expect, test } from "bun:test";
import { BodyLimitError, boundedBody } from "./bounded-body";
import { retryDelay } from "./retry";

test("unknown-length streams stop and cancel at the body budget", async () => {
  let pulls = 0, cancelled = false;
  const res = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }));
  await expect(boundedBody(res, 2048)).rejects.toBeInstanceOf(BodyLimitError);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(4);
});
test("known oversized bodies are cancelled without reading", async () => {
  let cancelled = false;
  const res = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "104857600" } });
  await expect(boundedBody(res, 2048)).rejects.toBeInstanceOf(BodyLimitError);
  expect(cancelled).toBe(true);
});
test("jitter has a positive floor, a ceiling and a spread", () => {
  expect(retryDelay(30000, () => 0)).toBe(15000);
  expect(retryDelay(30000, () => 1)).toBe(30000);
  expect(retryDelay(30000, () => 0.5)).toBe(22500);
});
