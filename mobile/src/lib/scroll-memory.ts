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
 * **A position is the id of the topmost visible row, never a pixel offset.**
 * That is the reader's rule and it is here for the reader's reason: a remount
 * re-measures every cell, and the rows above the fold are measured for the
 * first time as you scroll, so an offset saved before a remount names a
 * different place after one. A row id survives remeasurement, and it survives
 * the list changing under it — a snapshot arrives every few seconds and rows
 * come and go — because it is looked up by id when the time comes to restore.
 * When the row it names is gone, the list opens at the top, honestly, rather
 * than at whatever now happens to sit at that offset.
 *
 * Memory lives for the life of the process, like the reader's. Nothing here is
 * worth persisting to the Keychain: a cold start is a new session, and opening
 * at the top is the right answer then.
 */
import { useCallback, useRef } from "react";
import type { FlatList, ViewToken } from "react-native";

/** list key → the id of the row that was at the top. */
const places = new Map<string, string>();

/** Forgets one list's place. Used when a list is deliberately reset. */
export function forgetScrollPlace(key: string): void {
  places.delete(key);
}

/** Test seam: what the app currently remembers. */
export function scrollPlace(key: string): string | undefined {
  return places.get(key);
}

export interface RememberedScroll<T> {
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
  // Refreshed every render so the stable callbacks below always see the
  // current rows without being rebuilt.
  const latest = useRef(rows);
  latest.current = rows;
  // Read once, on mount: this is the place to go back to, and it is consumed
  // by the first restore. Later scrolls are the person's, and overwrite it.
  const pending = useRef<string | undefined>(places.get(key));

  // React Native refuses a changing `onViewableItemsChanged`, so its identity
  // is fixed for the life of the component and it reads through refs.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    // While a restore is still owed, what is on screen is where the list
    // happens to have opened, not where the person is. Recording it would
    // overwrite the very place being restored to.
    if (pending.current !== undefined) return;
    const top = viewableItems[0];
    if (typeof top?.key === "string") places.set(key, top.key);
  }).current;

  const onContentSizeChange = useCallback(() => {
    const want = pending.current;
    if (want === undefined) return;
    const data = latest.current();
    // An empty list is a list that has not loaded yet, not a list scrolled to
    // the top. Keep the memory and wait for rows.
    if (data.length === 0) return;
    pending.current = undefined;
    const index = data.findIndex((item) => idOf(item) === want);
    // index 0 is already the top, and a row that has gone means the honest
    // answer is the top — in both cases there is nothing to scroll to.
    if (index > 0) ref.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }, [idOf]);

  // A row far enough down may not be measured when the scroll is asked for.
  // The estimate gets close, and the list settles from there.
  const onScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
  }, []);

  return { ref, onViewableItemsChanged, viewabilityConfig, onContentSizeChange, onScrollToIndexFailed };
}
