import { useLayoutEffect, useRef, type RefObject } from "react";

type Place = { bottom: true } | { bottom: false; id: string | null; offset: number; top: number };
const places = new Map<string, Place>();
export const readerWasAway = (id: string) => places.get(id)?.bottom === false;
export function forgetReaderPlace(id?: string) { if (id === undefined) places.clear(); else places.delete(id); }

function capture(node: HTMLElement): Place {
  const top = node.scrollTop;
  if (node.scrollHeight - top - node.clientHeight < 80) return { bottom: true };
  const origin = node.getBoundingClientRect().top;
  const anchor = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().bottom > origin);
  return { bottom: false, id: anchor?.dataset.messageId ?? null, offset: anchor ? anchor.getBoundingClientRect().top - origin : 0, top };
}

/** DOM anchors survive prepended history, recreated readers and late image sizing. */
export function useReaderScroll({ paneId, scroller, ready, revision, following, onPosition }: {
  paneId: string; scroller: RefObject<HTMLDivElement | null>; ready: boolean; revision: unknown;
  following: RefObject<boolean>; onPosition: (bottom: boolean) => void;
}) {
  const place = useRef<Place>(places.get(paneId) ?? { bottom: true });
  const appliedTop = useRef<number | null>(null);
  const notify = useRef(onPosition); notify.current = onPosition;
  const apply = () => {
    const node = scroller.current;
    if (!node) return;
    const saved = place.current;
    if (saved.bottom && !following.current) return;
    let target = node.scrollHeight;
    if (!saved.bottom) {
      const row = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.dataset.messageId === saved.id);
      target = row ? node.scrollTop + row.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset : saved.top;
    }
    target = Math.max(0, Math.min(target, node.scrollHeight - node.clientHeight));
    if (Math.abs(node.scrollTop - target) > 1) { appliedTop.current = target; node.scrollTop = target; }
    following.current = saved.bottom;
    notify.current(saved.bottom);
  };
  const currentApply = useRef(apply); currentApply.current = apply;
  useLayoutEffect(() => {
    if (!ready || !scroller.current) return;
    const node = scroller.current;
    currentApply.current();
    // Observe message heights too: the scroll container itself keeps the same
    // height when a fetched image, font or expanded tool changes its contents.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => currentApply.current());
    observer?.observe(node);
    for (const child of node.children) observer?.observe(child);
    return () => { observer?.disconnect(); };
  }, [paneId, ready, revision, scroller]);
  return {
    stopFollowing() { appliedTop.current = null; following.current = false; },
    onScroll() {
      const node = scroller.current;
      if (!node) return;
      const restored = appliedTop.current;
      appliedTop.current = null;
      if (restored !== null && Math.abs(node.scrollTop - restored) <= 1) return;
      place.current = capture(node);
      places.set(paneId, place.current);
      following.current = place.current.bottom;
      notify.current(place.current.bottom);
    },
    goLatest() {
      place.current = { bottom: true };
      following.current = true;
      places.set(paneId, place.current);
      currentApply.current();
    },
    captureBeforePrepend() {
      if (scroller.current) {
        const node = scroller.current;
        const saved = capture(node);
        // Loading earlier is deliberate reading even when the old page was short.
        const first = node.querySelector<HTMLElement>("[data-message-id]");
        place.current = saved.bottom ? { bottom: false, id: first?.dataset.messageId ?? null, offset: first ? first.getBoundingClientRect().top - node.getBoundingClientRect().top : 0, top: node.scrollTop } : saved;
        places.set(paneId, place.current);
        following.current = false;
      }
    },
  };
}
