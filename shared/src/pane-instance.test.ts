/**
 * herdr reuses pane ids: close the highest space, restart herdr, create a
 * space, and it has the old one's ids. These are the pre-release bug hunt's
 * findings, as the shared helpers both clients use see them.
 */
import { expect, test } from "bun:test";
import { endedPanes, pinnedPanes, retainPins, togglePin } from "./pane-instance";

const session = (...panes: { paneId: string; instanceId?: string }[]) => ({ version: "0.9.1", panes });

test("a pin on one conversation does not pin the next conversation to get its pane id", () => {
  let pins = togglePin([], { paneId: "w3:p1", instanceId: "term_a" });
  expect(pinnedPanes(pins, [{ paneId: "w3:p1", instanceId: "term_a" }])).toEqual(new Set(["w3:p1"]));
  // Before the client has seen the pane close, the pin still cannot match another occupant.
  expect(pinnedPanes(pins, [{ paneId: "w3:p1", instanceId: "term_b" }])).toEqual(new Set());
  // And a session without the pane drops it, so it cannot come back either.
  pins = [...retainPins(pins, session({ paneId: "w1:p1", instanceId: "term_x" }))];
  expect(pins).toEqual([]);
});

test("a pin from before occupants were named takes the occupant it is on, and an older server keeps pins by id", () => {
  const upgraded = retainPins(["w3:p1"], session({ paneId: "w3:p1", instanceId: "term_a" }));
  expect(pinnedPanes(upgraded, [{ paneId: "w3:p1", instanceId: "term_b" }])).toEqual(new Set());
  const older = ["w3:p1"];
  expect(retainPins(older, session({ paneId: "w3:p1" }))).toBe(older);
  expect(pinnedPanes(togglePin([], { paneId: "w3:p1" }), [{ paneId: "w3:p1" }])).toEqual(new Set(["w3:p1"]));
});

test("unpinning removes the pin, and a session the sidecar sends before its first snapshot prunes nothing", () => {
  const pins = togglePin([], { paneId: "w3:p1", instanceId: "term_a" });
  expect(togglePin(pins, { paneId: "w3:p1", instanceId: "term_a" })).toEqual([]);
  expect(retainPins(pins, { version: "", panes: [] })).toBe(pins);
});

test("a conversation ends when its pane closes or another program takes the id, not when a list is merely unknown", () => {
  const before = session({ paneId: "w1:p1", instanceId: "a" }, { paneId: "w2:p1", instanceId: "b" }, { paneId: "w3:p1", instanceId: "c" });
  expect(endedPanes(before, session({ paneId: "w1:p1", instanceId: "a" }, { paneId: "w3:p1", instanceId: "c2" }))).toEqual(["w2:p1", "w3:p1"]);
  expect(endedPanes(before, { version: "", panes: [] })).toEqual([]);
  expect(endedPanes(null, before)).toEqual([]);
  // An older server names no occupant; only a close is seen.
  expect(endedPanes(session({ paneId: "w1:p1" }), session({ paneId: "w1:p1", instanceId: "a" }))).toEqual([]);
});
