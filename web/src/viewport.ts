/**
 * Keeps the app usable while the on-screen keyboard is open — and out of the
 * way the rest of the time.
 *
 * On iOS the keyboard does not shrink the layout viewport, it overlays it. So
 * `height: 100%` keeps reporting the full screen while the bottom half is
 * covered, and anything anchored down there is buried. On the Screen tab that
 * meant the key bar, the text box and Send all disappeared the moment you
 * tapped to type, which is precisely when you need them.
 *
 * The first version of this mirrored `visualViewport` at all times, and that
 * was a mistake. Safari's toolbars collapse and expand *as you scroll*, which
 * moves the visual viewport continuously — so the app's height and transform
 * were being rewritten throughout every flick, resizing the scroll container
 * mid-scroll and shifting the content under the finger. It made ordinary
 * scrolling feel broken, which is what it was.
 *
 * The compensation is conditional now. With no keyboard the app is plain 100%
 * and scrolling belongs entirely to the browser. Only when the visual viewport
 * is much shorter than the window — which nothing but a keyboard does — is the
 * height pinned and the offset applied.
 */

const HEIGHT = "--app-height";
const OFFSET = "--app-offset";

/**
 * How much shorter the visual viewport must be before this reads as a keyboard
 * rather than a toolbar. Safari's URL bar is roughly 60–120px; every keyboard
 * is far taller than that.
 */
export const KEYBOARD_THRESHOLD_PX = 180;

export interface ViewportState {
  /** Visual viewport height, or the window height where there is nothing better. */
  height: number;
  offsetTop: number;
  windowHeight: number;
}

export interface ViewportVars {
  /** CSS height for the app shell. `null` means "leave it at 100%". */
  height: string | null;
  offset: string | null;
}

/**
 * The whole decision, as a function of what the browser reports.
 *
 * Separated from the listener so it can be tested. This logic is the difference
 * between smooth scrolling and a page that fights the finger, and it is not
 * something a screenshot would ever show.
 */
export function varsFor(state: ViewportState): ViewportVars {
  const covered = state.windowHeight - state.height;
  if (covered < KEYBOARD_THRESHOLD_PX) return { height: null, offset: null };
  return { height: `${state.height}px`, offset: `${state.offsetTop}px` };
}

export function trackViewport(): () => void {
  const viewport = window.visualViewport;
  const root = document.documentElement;

  const apply = () => {
    const vars = varsFor({
      height: viewport?.height ?? window.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
      windowHeight: window.innerHeight,
    });

    if (vars.height === null) {
      root.style.removeProperty(HEIGHT);
      root.style.removeProperty(OFFSET);
      // The flag, not just the variables: a `translateY(0px)` is still a
      // transform, and a transformed ancestor changes how everything inside it
      // scrolls and sticks on iOS. With no keyboard there should be no
      // transform at all.
      delete root.dataset.keyboard;
    } else {
      root.style.setProperty(HEIGHT, vars.height);
      root.style.setProperty(OFFSET, vars.offset ?? "0px");
      root.dataset.keyboard = "open";
    }
  };

  apply();

  if (!viewport) {
    // Nothing better than the layout viewport, and `resize` at least catches
    // rotation.
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }

  // `resize` fires when the keyboard opens or closes. `scroll` is deliberately
  // no longer listened to: it fires throughout every flick, and reacting to it
  // was what made scrolling unsteady.
  viewport.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);

  return () => {
    viewport.removeEventListener("resize", apply);
    window.removeEventListener("orientationchange", apply);
  };
}
