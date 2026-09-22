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

// Every opened pane creates an entry, so the bound is reached by reading, not
// by typing. September 2026 review: the oldest entry went whatever it held.
test("checking twenty other agents keeps a typed reply and an uncertain send's operation ID", () => {
  const computer = {};
  nativeDraft(computer, "typed").text = "half-written reply";
  nativeDraft(computer, "uncertain").pending = { key: "reply", id: "operation-1" };
  nativeDraft(computer, "sending").inFlight = true;
  const onScreen = nativeDraft(computer, "on-screen");
  onScreen.listeners.add(() => {});
  for (let i = 0; i < 40; i++) nativeDraft(computer, `looked-at-${i}`);
  expect(nativeDraft(computer, "typed").text).toBe("half-written reply");
  expect(nativeDraft(computer, "uncertain").pending?.id).toBe("operation-1");
  expect(nativeDraft(computer, "sending").inFlight).toBe(true);
  expect(nativeDraft(computer, "on-screen")).toBe(onScreen);
});

test("when only typed drafts are left, the least recently opened one goes, and settled sends free their place", () => {
  const computer = {};
  for (let i = 0; i < 20; i++) nativeDraft(computer, `typed-${i}`).text = `reply ${i}`;
  nativeDraft(computer, "typed-0");
  nativeDraft(computer, "new");
  expect(nativeDraft(computer, "typed-0").text).toBe("reply 0");
  expect(nativeDraft(computer, "typed-1").text).toBe("");

  // Uncertain sends may take a scope past its bound; once they settle, the
  // next new pane brings it back down.
  const other = {};
  const uncertain = Array.from({ length: 25 }, (_, i) => {
    const draft = nativeDraft(other, `uncertain-${i}`);
    draft.pending = { key: "reply", id: `operation-${i}` };
    return draft;
  });
  expect(nativeDraft(other, "uncertain-0")).toBe(uncertain[0]);
  for (const draft of uncertain) draft.pending = null;
  nativeDraft(other, "new");
  expect(nativeDraft(other, "uncertain-7")).toBe(uncertain[7]);
  expect(nativeDraft(other, "uncertain-6")).not.toBe(uncertain[6]);
});
