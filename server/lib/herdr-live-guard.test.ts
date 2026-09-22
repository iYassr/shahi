import { describe, expect, test } from "bun:test";
import { liveSocketRefusal, runsInsideTarget } from "./herdr-live-guard";

/**
 * The live suite writes into whatever herdr it is pointed at. These are the
 * targets it must refuse, found in the September 2026 review: from inside a
 * herdr pane the only check it had — "HERDR_SOCKET_PATH is set" — passed on
 * the owner's own session.
 */
describe("which herdr the live suite may write to", () => {
  // What herdr puts in every pane of the default session.
  const pane = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w5:p1",
    HERDR_SOCKET_PATH: "/Users/me/.config/herdr/herdr.sock",
  };

  test("refuses the default session's socket that a herdr pane inherits", () => {
    expect(liveSocketRefusal(pane)).toContain("not a named session's socket");
  });

  test("refuses a bare socket override, which restores the default session", () => {
    expect(liveSocketRefusal({ HERDR_SOCKET_PATH: "/tmp/x.sock" })).toContain("not a named session's socket");
  });

  test("refuses to guess when no socket is named", () => {
    expect(liveSocketRefusal({})).toContain("needs HERDR_SOCKET_PATH");
  });

  test("accepts a named session under a fresh configuration root, as CI and the documented recipe start it", () => {
    expect(liveSocketRefusal({ HERDR_SOCKET_PATH: "/tmp/shahi-live.Ab12Cd/herdr/sessions/shahi-ci/herdr.sock" })).toBeNull();
    expect(
      liveSocketRefusal({ HERDR_SOCKET_PATH: "/home/runner/work/_temp/shahi-herdr-ci.x1/herdr/sessions/shahi-ci/herdr.sock" }),
    ).toBeNull();
  });

  test("a named session that holds this pane is the one the test runs inside", () => {
    const named = { ...pane, HERDR_SOCKET_PATH: "/Users/me/.config/herdr/sessions/work/herdr.sock" };
    expect(liveSocketRefusal(named)).toBeNull(); // the socket rule alone lets it through…
    expect(runsInsideTarget([{ pane_id: "w1:p1" }, { pane_id: "w5:p1" }], named)).toBe(true); // …this does not
  });

  test("a fresh session, or a run outside herdr, is not the one the test runs inside", () => {
    expect(runsInsideTarget([], pane)).toBe(false);
    expect(runsInsideTarget([{ pane_id: "w1:p1" }], pane)).toBe(false);
    expect(runsInsideTarget([{ pane_id: "w1:p1" }], {})).toBe(false);
  });
});
