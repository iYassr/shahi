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
