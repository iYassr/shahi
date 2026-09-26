import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HerdrClient, HerdrError, RequestTooLarge } from "./herdr-client";
import { refusedBeforeDelivery, trackDelivery } from "./herdr-delivery";

/** The error a real client gives when herdr's socket is not there. */
async function noSocket(): Promise<unknown> {
  const client = new HerdrClient({ socketPath: join(tmpdir(), `shahi-no-herdr-${process.pid}.sock`) });
  return client.rpc("ping", {}).then(() => { throw new Error("a socket answered"); }, (err) => err);
}

test("a missing herdr socket is recognised as nothing sent", async () => {
  expect(refusedBeforeDelivery(await noSocket())).toBe(true);
});

// herdr closes the connection, unanswered, on a request over 1 MiB, and that
// silence counted as delivered: the retry got the same failure for ten
// minutes (pre-release bug hunt, B2). The client now refuses it unwritten.
test("a request too long for herdr to read is nothing sent", () => {
  expect(refusedBeforeDelivery(new RequestTooLarge("pane.send_text", 2_000_000))).toBe(true);
});

test("herdr's refusals about the target are nothing sent; other answers are not", () => {
  expect(refusedBeforeDelivery(new HerdrError("agent_not_ready", "", "agent.prompt"))).toBe(true);
  expect(refusedBeforeDelivery(new HerdrError("invalid_params", "", "pane.send_text"))).toBe(true);
  expect(refusedBeforeDelivery(new HerdrError("agent_start_timeout", "", "agent.start"))).toBe(false);
  expect(refusedBeforeDelivery(new Error("herdr agent.prompt timed out after 5000ms"))).toBe(false);
  expect(refusedBeforeDelivery(new Error("herdr closed the socket before answering agent.prompt"))).toBe(false);
});

test("text typed before a failed Enter counts as delivered, so the failure is kept", async () => {
  const down = await noSocket();
  const delivery = trackDelivery(async (method: string, _params?: unknown) => {
    if (method === "pane.send_keys") throw down;
    return {};
  });
  await delivery.rpc("pane.send_text", {} as never);
  await expect(delivery.rpc("pane.send_keys", {} as never)).rejects.toBe(down);
  expect(delivery.reachedNothing()).toBe(false);
});

// The prompt route's fallback: herdr refuses a blocked agent before typing,
// then the terminal path finds herdr gone. Nothing was typed at all.
test("a refusal followed by a missing socket reached nothing", async () => {
  const down = await noSocket();
  const delivery = trackDelivery(async (method: string, _params?: unknown) => {
    if (method === "agent.prompt") throw new HerdrError("agent_blocked", "", method);
    throw down;
  });
  await expect(delivery.rpc("agent.prompt", {} as never)).rejects.toBeInstanceOf(HerdrError);
  await expect(delivery.rpc("pane.send_text", {} as never)).rejects.toBe(down);
  expect(delivery.reachedNothing()).toBe(true);
});

// Found integrating the review fixes: the prompt route's screen read (F41)
// made every refusal "delivered", so a retry got the refusal for ten minutes.
test("an operation that only read the screen reached nothing, however the read went", async () => {
  const ok = trackDelivery((async () => ({ read: { text: "" } })) as never);
  await (ok.rpc as (m: string, p: never) => Promise<unknown>)("pane.read", {} as never);
  expect(ok.reachedNothing()).toBe(true);

  const failed = trackDelivery((async () => { throw new Error("timed out"); }) as never);
  await expect((failed.rpc as (m: string, p: never) => Promise<unknown>)("agent.get", {} as never)).rejects.toThrow();
  expect(failed.reachedNothing()).toBe(true);
});

// Pre-release bug hunt, B4 re-verification: a message to a pane herdr has not
// named an agent asks who has its terminal before reading its screen. Were
// that a write, a message refused at a menu there would be refused again for
// ten minutes after the menu had gone.
test("asking who has a pane's terminal, then reading its screen, reached nothing", async () => {
  const t = trackDelivery((async () => ({})) as never);
  const call = t.rpc as (m: string, p: never) => Promise<unknown>;
  await call("pane.get", {} as never);
  await call("pane.process_info", {} as never);
  await call("pane.read", {} as never);
  expect(t.reachedNothing()).toBe(true);
});

test("a read followed by a write is delivered", async () => {
  const t = trackDelivery((async () => ({})) as never);
  const call = t.rpc as (m: string, p: never) => Promise<unknown>;
  await call("pane.read", {} as never);
  await call("pane.send_text", {} as never);
  expect(t.reachedNothing()).toBe(false);
});

