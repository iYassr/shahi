import { useEffect, type RefObject } from "react";
import { useLocation } from "react-router-dom";

/**
 * Puts a scroll container back where you left it.
 *
 * Browsers restore the *window's* scroll across history entries, and every
 * scrolling region in this app is a flex child instead — so going into a pane
 * and coming back landed you at the top of the list every time. On a phone,
 * with a dozen agents, that is the difference between an app and a website.
 *
 * Keyed by route, kept in memory: it should survive navigation, not a reload.
 */
const positions = new Map<string, number>();

export function useScrollMemory(ref: RefObject<HTMLElement | null>, ready: boolean): void {
  const { key } = useLocation();

  useEffect(() => {
    const node = ref.current;
    if (!node || !ready) return;

    const saved = positions.get(key);
    // After paint, or the content is not tall enough to scroll to yet.
    if (saved) requestAnimationFrame(() => node.scrollTo(0, saved));

    const remember = () => positions.set(key, node.scrollTop);
    node.addEventListener("scroll", remember, { passive: true });
    return () => {
      remember();
      node.removeEventListener("scroll", remember);
    };
  }, [ref, key, ready]);
}
