/**
 * Where each list was, so coming back to it lands where you left.
 *
 * Every list in the app is a place you leave and return to: the agent list
 * when you open a conversation, the spaces list when you open a space, the
 * tabs inside a space when you open a pane. Each one threw you back to the top
 * on the way back, which on a long list means finding your place by hand every
 * time — the same complaint the reader's own memory was written to answer
 * (`scrollMemory` in `screens/pane.tsx`).
 *
 * **A position is a row id plus the pixel offset within that row.**
 * That is the reader's rule and it is here for the reader's reason: a remount
 * re-measures every cell, and the rows above the fold are measured for the
 * first time as you scroll, so an offset saved before a remount names a
 * different place after one. A row id survives remeasurement, and it survives
 * the list changing under it — a snapshot arrives every few seconds and rows
 * come and go — because it is looked up by id when the time comes to restore.
 * Keeping the intra-row offset matters for tall prompt cards and for a partly
 * visible first row/header. An id alone jumps back to the start of that row.
 * When the row it names is gone, the list opens at the top, honestly, rather
 * than at whatever now happens to sit at that offset.
 *
 * Memory lives for the life of the process, like the reader's. Nothing here is
 * worth persisting to the Keychain: a cold start is a new session, and opening
 * at the top is the right answer then.
 */
import { useCallback, useEffect, useRef } from "react";
import type { FlatList, ViewToken, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { anchorAt, useScrollCells, type ScrollAnchor } from "./scroll-cells";

/** list key → the id of the row that was at the top. */
const places = new Map<string, ScrollAnchor>();

/** Forgets one list's place. Used when a list is deliberately reset. */
export function forgetScrollPlace(key: string): void {
  places.delete(key);
}

/** Test seam: what the app currently remembers. */
export function scrollPlace(key: string): string | undefined {
  return places.get(key)?.id;
}

export interface RememberedScroll<T> {
  CellRendererComponent: ReturnType<typeof useScrollCells<T>>["CellRendererComponent"];
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollBegin: () => void;
  onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
  ref: React.RefObject<FlatList<T> | null>;
  onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void;
  viewabilityConfig: { itemVisiblePercentThreshold: number };
  onContentSizeChange: () => void;
  onScrollToIndexFailed: (info: { index: number; averageItemLength: number }) => void;
}

/**
 * Remembers, and restores, where a FlatList was.
 *
 * `key` identifies the list — one per screen, and per space for the tab list,
 * so two spaces do not share a place. Spread the result onto the FlatList.
 */
export function useRememberedScroll<T>(
  key: string,
  /**
   * The rows, read at restore time rather than taken as a value, so the hook
   * can be called at the top of a component — above the early returns that
   * every one of these screens has — while the list it describes is computed
   * further down.
   */
  rows: () => readonly T[],
  idOf: (item: T) => string,
): RememberedScroll<T> {
  const ref = useRef<FlatList<T> | null>(null);
  const cells = useScrollCells(idOf);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const userScroll = useRef(false);
  useEffect(() => () => clearTimeout(retry.current), []);
  // Refreshed every render so the stable callbacks below always see the
  // current rows without being rebuilt.
  const latest = useRef(rows);
  latest.current = rows;
  // Read once on mount and keep it immutable until the measured target lands
  // or the user takes over. An estimated scroll is not a completed restore.
  const pending = useRef<ScrollAnchor | undefined>(places.get(key));

  // React Native refuses a changing `onViewableItemsChanged`, so its identity
  // is fixed for the life of the component and it reads through refs.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    // While a restore is still owed, what is on screen is where the list
    // happens to have opened, not where the person is. Recording it would
    // overwrite the very place being restored to.
    if (pending.current !== undefined) return;
    const top = viewableItems[0];
    // Native scroll events capture the pixel-within-row position. Viewability
    // is only a fallback before any measured cells exist, not a second writer
    // racing the scroll event with an older top row.
    if (typeof top?.key === "string" && cells.frames.current.size === 0) places.set(key, { id: top.key, offset: 0 });
  }).current;

  const onContentSizeChange = useCallback(() => {
    const want = pending.current;
    if (want === undefined) return;
    const data = latest.current();
    // An empty list is a list that has not loaded yet, not a list scrolled to
    // the top. Keep the memory and wait for rows.
    if (data.length === 0) return;
    const index = data.findIndex((item) => idOf(item) === want.id);
    // Even index zero can have a saved position inside a tall first card.
    if (index < 0) { pending.current = undefined; return; }
    ref.current?.scrollToIndex({ index, animated: false, viewPosition: 0, ...(want.offset ? { viewOffset: -want.offset } : {}) });
  }, [idOf]);

  // A row far enough down may not be measured when the scroll is asked for.
  // The estimate renders nearby cells; retry the exact anchor after measuring.
  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    clearTimeout(retry.current);
    retry.current = setTimeout(onContentSizeChange, 100);
  }, [onContentSizeChange]);

  const remember = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = nativeEvent.contentOffset.y;
    const anchor = anchorAt(cells.frames.current, y);
    if (anchor) places.set(key, anchor);
  }, [key]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const want = pending.current;
    if (want) {
      const y = event.nativeEvent.contentOffset.y;
      const frame = cells.frames.current.get(want.id);
      if (frame && Math.abs(y - frame.y - want.offset) < 2) pending.current = undefined;
      return;
    }
    // iOS emits scroll events while a screen is settling out of the native
    // stack. Those are not a new reading position: accepting the final zero
    // offset is why Back → reopen jumped to the top. Only a finger drag (and
    // its momentum) is allowed to replace the remembered place.
    if (userScroll.current) remember(event);
  }, [remember]);

  return { ref, CellRendererComponent: cells.CellRendererComponent, onScroll, scrollEventThrottle: 16,
    onScrollBeginDrag: () => { pending.current = undefined; clearTimeout(retry.current); userScroll.current = true; },
    onScrollEndDrag: (event) => { remember(event); userScroll.current = false; },
    onMomentumScrollBegin: () => { userScroll.current = true; },
    onMomentumScrollEnd: (event) => { remember(event); userScroll.current = false; },
    onViewableItemsChanged, viewabilityConfig, onContentSizeChange, onScrollToIndexFailed };
}
