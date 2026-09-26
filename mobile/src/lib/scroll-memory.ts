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
 * Memory lives for the life of the process, like the reader's, and belongs to
 * the computer whose list it is: `owner` is that computer's API object, as for
 * the reader and drafts. One process-wide map keyed only by the list's name
 * carried a place from one computer to another, and from before a sign-out to
 * the same computer paired again (pre-release bug hunt). Nothing here is
 * worth persisting to the Keychain: a cold start is a new session, and opening
 * at the top is the right answer then.
 */
import { useCallback, useEffect, useRef } from "react";
import type { FlatList, ViewToken, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { anchorAt, useScrollCells, type ScrollAnchor } from "./scroll-cells";

/** list key → the id of the row that was at the top, per computer. */
const owned = new WeakMap<object, Map<string, ScrollAnchor>>();
/** Lists with no computer behind them. */
const unowned = new Map<string, ScrollAnchor>();
function placesOf(owner: object | undefined): Map<string, ScrollAnchor> {
  if (!owner) return unowned;
  let places = owned.get(owner);
  if (!places) owned.set(owner, places = new Map());
  return places;
}

/** Forgets one list's place. Used when a list is deliberately reset. */
export function forgetScrollPlace(key: string, owner?: object): void {
  placesOf(owner).delete(key);
}

/** Test seam: what the app currently remembers. */
export function scrollPlace(key: string, owner?: object): string | undefined {
  return placesOf(owner).get(key)?.id;
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
  /** The computer the list belongs to: its API object. */
  owner?: object,
): RememberedScroll<T> {
  const ref = useRef<FlatList<T> | null>(null);
  const cells = useScrollCells(idOf);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const userScroll = useRef(false);
  /** A drag just ended, so a momentum that begins now is the person's fling. */
  const afterDrag = useRef(false);
  /** The momentum under way followed a drag. */
  const flung = useRef(false);
  const places = placesOf(owner);
  const placesRef = useRef(places);
  placesRef.current = places;
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
    if (typeof top?.key === "string" && cells.frames.current.size === 0) placesRef.current.set(key, { id: top.key, offset: 0 });
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
    // At or above zero is the list's own top. Under automatic insets the
    // resting top is negative, behind the large title, and a place recorded
    // there (a row before the first, at a negative offset) restored to y=0:
    // the search field and filter chips opened hidden under the title
    // (pre-release bug hunt). The top is remembered as no place at all.
    if (y <= 0) { placesRef.current.delete(key); return; }
    const anchor = anchorAt(cells.frames.current, y);
    if (anchor) placesRef.current.set(key, anchor);
  }, [key]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const want = pending.current;
    if (want) {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const y = contentOffset.y;
      const frame = cells.frames.current.get(want.id);
      // Landed; or stopped at the end of a list too short to put the row at
      // the top, which is as close as it can come. Owed for ever, the restore
      // pulled the list back to it on every snapshot.
      const bottom = contentSize && layoutMeasurement ? contentSize.height - layoutMeasurement.height : Infinity;
      if (frame && (Math.abs(y - frame.y - want.offset) < 2 || y >= bottom - 1 && y < frame.y + want.offset)) pending.current = undefined;
      return;
    }
    // iOS emits scroll events while a screen is settling out of the native
    // stack. Those are not a new reading position: accepting the final zero
    // offset is why Back → reopen jumped to the top. Only a finger drag (and
    // its momentum) is allowed to replace the remembered place.
    if (userScroll.current) remember(event);
  }, [remember]);

  return { ref, CellRendererComponent: cells.CellRendererComponent, onScroll, scrollEventThrottle: 16,
    onScrollBeginDrag: () => { pending.current = undefined; clearTimeout(retry.current); userScroll.current = true; afterDrag.current = false; },
    onScrollEndDrag: (event) => { remember(event); userScroll.current = false; afterDrag.current = true; },
    // iOS also ends a "momentum" when the list leaves the window, with no
    // drag behind it, and recording that took a settling screen's offset for
    // a place (pre-release bug hunt). Only a fling that followed a drag counts.
    onMomentumScrollBegin: () => { flung.current = afterDrag.current; afterDrag.current = false; userScroll.current = flung.current; },
    onMomentumScrollEnd: (event) => { if (flung.current) remember(event); flung.current = false; userScroll.current = false; },
    onViewableItemsChanged, viewabilityConfig, onContentSizeChange, onScrollToIndexFailed };
}
