import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HerdrClient, HerdrError } from "./herdr-client";
import { refusedBeforeDelivery, trackDelivery } from "./herdr-delivery";

/** The error a real client gives when herdr's socket is not there. */
async function noSocket(): Promise<unknown> {
  const client = new HerdrClient({ socketPath: join(tmpdir(), `shahi-no-herdr-${process.pid}.sock`) });
  return client.rpc("ping", {}).then(() => { throw new Error("a socket answered"); }, (err) => err);
}

test("a missing herdr socket is recognised as nothing sent", async () => {
  expect(refusedBeforeDelivery(await noSocket())).toBe(true);
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
