import { describe, expect, test } from "bun:test";
import { CRAMPED_HEIGHT_PX, KEYBOARD_THRESHOLD_PX, varsFor } from "./viewport";

/**
 * The rule this encodes: compensate for a keyboard, never for a toolbar.
 *
 * Reacting to Safari's collapsing URL bar meant rewriting the app's height
 * during every scroll, which is what made scrolling feel unstable. These cases
 * are the difference between the two.
 */
describe("varsFor", () => {
  test("leaves the app alone when nothing is covering it", () => {
    expect(varsFor({ height: 844, offsetTop: 0, windowHeight: 844 })).toEqual({
      height: null,
      offset: null,
      cramped: false,
    });
  });

  test("ignores the toolbar collapsing and expanding mid-scroll", () => {
    // Safari's URL bar is around this much, and it changes continuously while
    // a flick is in progress.
    expect(varsFor({ height: 760, offsetTop: 0, windowHeight: 844 })).toEqual({
      height: null,
      offset: null,
      cramped: false,
    });
    expect(varsFor({ height: 844 - (KEYBOARD_THRESHOLD_PX - 1), offsetTop: 0, windowHeight: 844 })).toEqual({
      height: null,
      offset: null,
      cramped: false,
    });
  });

  test("pins the app when a keyboard is open", () => {
    expect(varsFor({ height: 508, offsetTop: 0, windowHeight: 844 })).toEqual({
      height: "508px",
      offset: "0px",
      cramped: false,
    });
  });

  test("carries the offset, so the header does not drift off screen", () => {
    expect(varsFor({ height: 508, offsetTop: 42, windowHeight: 844 })).toEqual({
      height: "508px",
      offset: "42px",
      cramped: false,
    });
  });

  test("a viewport larger than the window is not a keyboard", () => {
    // Pinch-zooming out reports this; treating it as a keyboard would clamp the
    // app to a height nobody asked for.
    expect(varsFor({ height: 900, offsetTop: 0, windowHeight: 844 })).toEqual({
      height: null,
      offset: null,
      cramped: false,
    });

  });

  test("flags the landscape case, where the chrome does not fit", () => {
    // Phone on its side with the keyboard up: about 190px left.
    expect(varsFor({ height: 190, offsetTop: 0, windowHeight: 390 })).toEqual({
      height: "190px",
      offset: "0px",
      cramped: true,
    });
    expect(CRAMPED_HEIGHT_PX).toBeGreaterThan(190);
  });
});
