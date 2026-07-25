/**
 * Keeps the app sized to the *visual* viewport rather than the layout viewport.
 *
 * On iOS the on-screen keyboard does not shrink the layout viewport — it
 * overlays it. So `height: 100%` keeps reporting the full screen while the
 * bottom half is covered, and anything anchored down there is simply buried.
 * On the Screen tab that meant the key bar, the text box and Send all
 * disappeared the moment you tapped to type, which is precisely when you need
 * them.
 *
 * `visualViewport` reports what is actually visible, keyboard subtracted, so
 * the app is sized from that instead. `interactive-widget=resizes-content` in
 * the viewport meta covers browsers that implement it; this covers the rest,
 * and the two agree.
 *
 * `offsetTop` matters as well: with the keyboard open the page can be scrolled
 * *under* it, and without pinning to the visual viewport's top the header
 * drifts off screen.
 */

const HEIGHT = "--app-height";
const OFFSET = "--app-offset";

export function trackViewport(): () => void {
  const viewport = window.visualViewport;
  const root = document.documentElement;

  const apply = () => {
    root.style.setProperty(HEIGHT, `${viewport?.height ?? window.innerHeight}px`);
    root.style.setProperty(OFFSET, `${viewport?.offsetTop ?? 0}px`);
  };

  apply();

  // Without visualViewport there is nothing better than the layout viewport,
  // and `resize` at least catches rotation.
  if (!viewport) {
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }

  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  window.addEventListener("orientationchange", apply);

  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    window.removeEventListener("orientationchange", apply);
  };
}
