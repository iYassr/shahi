/**
 * The list-place memory, which is the kind of thing that regresses in silence:
 * nothing throws when a list forgets where it was, you just find yourself at
 * the top again. Every test here is named after the symptom it prevents.
 */
import { renderHook, act } from "@testing-library/react-native";
import type { ViewToken } from "react-native";
import { forgetScrollPlace, scrollPlace, useRememberedScroll } from "./scroll-memory";

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const idOf = (r: Row) => r.id;

/** What a FlatList would give the hook when `ids` are on screen, first at the top. */
const viewable = (...ids: string[]) =>
  ({ viewableItems: ids.map((key) => ({ key, isViewable: true })) as unknown as ViewToken[] });

function mount(key: string, data: Row[]) {
  const view = renderHook(() => useRememberedScroll<Row>(key, () => data, idOf));
  const list = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn() };
  view.result.current.ref.current = list as never;
  return { ...view, list, api: () => view.result.current };
}

beforeEach(() => {
  forgetScrollPlace("list");
  jest.clearAllMocks();
});

test("remembers the row that was at the top", () => {
  const { api } = mount("list", rows("a", "b", "c", "d"));
  act(() => api().onViewableItemsChanged(viewable("c", "d")));
  expect(scrollPlace("list")).toBe("c");
});

test("coming back scrolls to the row you left at the top, not to the top", () => {
  const data = rows("a", "b", "c", "d");
  const first = mount("list", data);
  act(() => first.api().onViewableItemsChanged(viewable("c", "d")));
  first.unmount();

  // A fresh mount, as a remount after leaving for a conversation would be.
  const again = mount("list", data);
  act(() => again.api().onContentSizeChange());
  expect(again.list.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false, viewPosition: 0 });
});

// The list opens at the top and reports that as visible before the restore has
// run. Recording it would overwrite the very place being restored to — the bug
// that makes a memory look like it works once and then never again.
test("what the list shows before the restore does not overwrite the memory", () => {
  const data = rows("a", "b", "c", "d");
  const first = mount("list", data);
  act(() => first.api().onViewableItemsChanged(viewable("c", "d")));
  first.unmount();

  const again = mount("list", data);
  act(() => again.api().onViewableItemsChanged(viewable("a", "b"))); // opened at the top
  expect(scrollPlace("list")).toBe("c");
  act(() => again.api().onContentSizeChange());
  expect(again.list.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false, viewPosition: 0 });
});

test("after the restore, scrolling records the new place", () => {
  const data = rows("a", "b", "c", "d");
  const { api } = mount("list", data);
  act(() => api().onContentSizeChange()); // nothing remembered: no restore owed
  act(() => api().onViewableItemsChanged(viewable("b")));
  expect(scrollPlace("list")).toBe("b");
});

// A pane closed from the TUI, a space removed: the row that was at the top is
// simply gone. Opening at the top is honest; guessing an offset is not.
test("a row that has gone means the top, not a guessed position", () => {
  const first = mount("list", rows("a", "b", "c"));
  act(() => first.api().onViewableItemsChanged(viewable("c")));
  first.unmount();

  const again = mount("list", rows("a", "b")); // "c" closed while away
  act(() => again.api().onContentSizeChange());
  expect(again.list.scrollToIndex).not.toHaveBeenCalled();
});

// The first content-size change arrives before the session snapshot does, so
// the list is briefly empty. Consuming the restore then would spend it on
// nothing, and the rows that arrive a moment later would open at the top —
// within the same mount, so no remount comes along to save it.
test("a list still waiting for its rows keeps the restore owed", () => {
  const first = mount("list", rows("a", "b", "c"));
  act(() => first.api().onViewableItemsChanged(viewable("c")));
  first.unmount();

  // One mount whose rows arrive after it: empty, then the snapshot lands.
  let data: Row[] = [];
  const view = renderHook(() => useRememberedScroll<Row>("list", () => data, idOf));
  const list = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn() };
  view.result.current.ref.current = list as never;

  act(() => view.result.current.onContentSizeChange()); // fires while empty
  expect(list.scrollToIndex).not.toHaveBeenCalled();

  data = rows("a", "b", "c"); // the snapshot arrives
  act(() => view.result.current.onContentSizeChange());
  expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false, viewPosition: 0 });
});

test("two lists do not share a place", () => {
  forgetScrollPlace("space:1");
  forgetScrollPlace("space:2");
  const one = mount("space:1", rows("a", "b"));
  const two = mount("space:2", rows("x", "y"));
  act(() => one.api().onViewableItemsChanged(viewable("b")));
  act(() => two.api().onViewableItemsChanged(viewable("y")));
  expect(scrollPlace("space:1")).toBe("b");
  expect(scrollPlace("space:2")).toBe("y");
});

// A row far down may not be measured when the scroll is asked for; FlatList
// says so rather than scrolling, and the estimate gets close enough.
test("an unmeasured row falls back to an estimated offset", () => {
  const { api, list } = mount("list", rows("a", "b", "c"));
  act(() => api().onScrollToIndexFailed({ index: 2, averageItemLength: 80 }));
  expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 160, animated: false });
});
