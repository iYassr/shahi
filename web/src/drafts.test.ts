import { expect, test } from "bun:test";
import { clearWebDrafts, draftOwner, webDraft } from "./drafts";
test("identical pane IDs remain isolated per computer and pairing grant", () => {
  const a = draftOwner({ serverId: "a", deviceId: "device" });
  const b = draftOwner({ serverId: "b", deviceId: "device" });
  const first = webDraft(a, "w1:p1");
  first.text = "private draft"; first.pending = { body: "private draft", id: "retry-id" };
  expect(webDraft(b, "w1:p1").text).toBe("");
  expect(webDraft(a, "w1:p1")).toBe(first);
  expect(webDraft(a, "w1:p1").pending?.id).toBe("retry-id");
  expect(webDraft(draftOwner({ serverId: "a", deviceId: "new-grant" }), "w1:p1").text).toBe("");
  clearWebDrafts(a);
  first.text = "late old response";
  expect(webDraft(a, "w1:p1").text).toBe("");
});

// Every opened pane creates an entry, so the bound is reached by reading, not
// by typing. September 2026 review: the oldest entry went whatever it held.
test("checking twenty other agents keeps a typed reply, an attachment and an uncertain send's operation ID", () => {
  const computer = draftOwner({ serverId: "eviction", deviceId: "device" });
  webDraft(computer, "typed").text = "half-written reply";
  webDraft(computer, "attached").attachments = [{ name: "plan.md", path: "/tmp/plan.md" }];
  webDraft(computer, "uncertain").pending = { body: "reply", id: "operation-1" };
  webDraft(computer, "sending").inFlight = true;
  const onScreen = webDraft(computer, "on-screen");
  onScreen.listeners.add(() => {});
  for (let i = 0; i < 40; i++) webDraft(computer, `looked-at-${i}`);
  expect(webDraft(computer, "typed").text).toBe("half-written reply");
  expect(webDraft(computer, "attached").attachments).toHaveLength(1);
  expect(webDraft(computer, "uncertain").pending?.id).toBe("operation-1");
  expect(webDraft(computer, "sending").inFlight).toBe(true);
  expect(webDraft(computer, "on-screen")).toBe(onScreen);
});

test("when only typed drafts are left, the least recently opened one goes", () => {
  const computer = draftOwner({ serverId: "recency", deviceId: "device" });
  for (let i = 0; i < 20; i++) webDraft(computer, `typed-${i}`).text = `reply ${i}`;
  webDraft(computer, "typed-0");
  webDraft(computer, "new");
  expect(webDraft(computer, "typed-0").text).toBe("reply 0");
  expect(webDraft(computer, "typed-1").text).toBe("");
});
