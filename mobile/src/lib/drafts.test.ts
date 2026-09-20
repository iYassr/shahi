import { clearNativeDrafts, nativeDraft } from "./drafts";
test("computer API identities isolate equal pane IDs and revoked drafts cannot return", () => {
  const a = {}, b = {};
  const draft = nativeDraft(a, "w1:p1");
  draft.text = "private draft"; draft.pending = { key: "operation", id: "retry-id" };
  expect(nativeDraft(b, "w1:p1").text).toBe("");
  expect(nativeDraft(a, "w1:p1")).toBe(draft);
  expect(nativeDraft(a, "w1:p1").pending?.id).toBe("retry-id");
  clearNativeDrafts(a);
  draft.text = "late result";
  expect(nativeDraft(a, "w1:p1").text).toBe("");
});
