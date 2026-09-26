/**
 * The list-place memory, which is the kind of thing that regresses in silence:
 * nothing throws when a list forgets where it was, you just find yourself at
 * the top again. Every test here is named after the symptom it prevents.
 */
import { renderHook, render, fireEvent, act } from "@testing-library/react-native";
import { createElement } from "react";
import { View, type ViewToken } from "react-native";
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

test("returning preserves a point inside a tall row even if earlier rows changed height", () => {
  const data = rows("a", "b", "c");
  const first = mount("list", data);
  const cell = render(createElement(first.api().CellRendererComponent, { item: data[2]!, cellKey: "c", index: 2, children: null, style: undefined }));
  fireEvent(cell.UNSAFE_getByType(View), "layout", { nativeEvent: { layout: { y: 200, height: 1000 } } });
  const event = { nativeEvent: { contentOffset: { y: 655 } } } as never;
  act(() => first.api().onScrollBeginDrag());
  act(() => first.api().onScroll(event));
  act(() => first.api().onScrollEndDrag(event));
  // Native navigation settling is programmatic and must not erase the place.
  act(() => first.api().onScroll({ nativeEvent: { contentOffset: { y: 0 } } } as never));
  // Viewability can report an earlier row after onScroll. It must not replace
  // the measured anchor with that stale row or erase the intra-row offset.
  act(() => first.api().onViewableItemsChanged(viewable("b", "c")));
  first.unmount();
  cell.unmount();
  const again = mount("list", data);
  act(() => again.api().onContentSizeChange());
  expect(again.list.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false, viewPosition: 0, viewOffset: -455 });
  act(() => again.api().onViewableItemsChanged(viewable("a")));
  expect(scrollPlace("list")).toBe("c");
});

test("failed index restoration retries without accepting the estimated landing as the saved place", () => {
  jest.useFakeTimers();
  const first = mount("list", rows("a", "b", "c"));
  act(() => first.api().onViewableItemsChanged(viewable("c")));
  first.unmount();
  const again = mount("list", rows("a", "b", "c"));
  act(() => again.api().onContentSizeChange());
  act(() => again.api().onScrollToIndexFailed({ index: 2, averageItemLength: 80 }));
  act(() => again.api().onViewableItemsChanged(viewable("b")));
  act(() => jest.advanceTimersByTime(100));
  expect(scrollPlace("list")).toBe("c");
  expect(again.list.scrollToIndex).toHaveBeenCalledTimes(2);
  again.unmount();
  jest.useRealTimers();
});

test("a middle row in a long agents list survives repeated visits and insertion above it", () => {
  const data = Array.from({ length: 150 }, (_, i) => ({ id: `agent-${i}` }));
  const first = mount("list", data);
  const cell = render(createElement(first.api().CellRendererComponent, {
    item: data[75]!, cellKey: "agent-75", index: 75, children: null, style: undefined,
  }));
  fireEvent(cell.UNSAFE_getByType(View), "layout", { nativeEvent: { layout: { y: 6000, height: 80 } } });
  act(() => first.api().onScrollBeginDrag());
  act(() => first.api().onScroll({ nativeEvent: { contentOffset: { y: 6023 } } } as never));
  first.unmount();
  cell.unmount();
  for (const shifted of [data, [{ id: "new-agent" }, ...data]]) {
    const again = mount("list", shifted);
    act(() => again.api().onViewableItemsChanged(viewable(shifted[0]!.id)));
    act(() => again.api().onContentSizeChange());
    expect(again.list.scrollToIndex).toHaveBeenLastCalledWith({
      index: shifted.findIndex((row) => row.id === "agent-75"),
      animated: false, viewPosition: 0, viewOffset: -23,
    });
    again.unmount();
  }
});

// Signing out and pairing again, or switching computers, opened the Agents
// list with its search field, filter chips and "+ New agent" hidden under the
// large title, three times in three (pre-release bug hunt).
describe("the list a person comes back to after a sign-in or a switch", () => {
  /** A measured first row below the list's header, as the Agents list has. */
  function measured(view: ReturnType<typeof mount>, data: Row[]) {
    const cell = render(createElement(view.api().CellRendererComponent, { item: data[0]!, cellKey: data[0]!.id, index: 0, children: null, style: undefined }));
    fireEvent(cell.UNSAFE_getByType(View), "layout", { nativeEvent: { layout: { y: 300, height: 80 } } });
    return cell;
  }

  test("the list at rest at its top is remembered as the top, not as a place behind the large title", () => {
    const data = rows("a", "b", "c");
    const first = mount("list", data);
    const cell = measured(first, data);
    // Automatic insets: the resting top is negative, behind the large title.
    const top = { nativeEvent: { contentOffset: { y: -140 } } } as never;
    act(() => first.api().onScrollBeginDrag());
    act(() => first.api().onScroll(top));
    act(() => first.api().onScrollEndDrag(top));
    expect(scrollPlace("list")).toBeUndefined();
    first.unmount(); cell.unmount();
    const again = mount("list", data);
    act(() => again.api().onContentSizeChange());
    expect(again.list.scrollToIndex).not.toHaveBeenCalled();
  });

  test("a list leaving the window does not take its settling offset for a place", () => {
    const data = rows("a", "b", "c");
    const first = mount("list", data);
    const cell = measured(first, data);
    // No drag: iOS ends a momentum as the view leaves the window.
    act(() => first.api().onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 310 } } } as never));
    act(() => first.api().onMomentumScrollBegin());
    act(() => first.api().onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 320 } } } as never));
    expect(scrollPlace("list")).toBeUndefined();
    // A real fling still counts.
    act(() => first.api().onScrollBeginDrag());
    act(() => first.api().onScrollEndDrag({ nativeEvent: { contentOffset: { y: 305 } } } as never));
    act(() => first.api().onMomentumScrollBegin());
    act(() => first.api().onMomentumScrollEnd({ nativeEvent: { contentOffset: { y: 330 } } } as never));
    expect(scrollPlace("list")).toBe("a");
    first.unmount(); cell.unmount();
  });

  test("each computer keeps its own place, and a new sign-in starts at the top", () => {
    const one = {}; const two = {};
    const data = rows("a", "b", "c", "d");
    const first = renderHook(() => useRememberedScroll<Row>("agents", () => data, idOf, one));
    act(() => first.result.current.onViewableItemsChanged(viewable("c")));
    first.unmount();
    expect(scrollPlace("agents", one)).toBe("c");
    // Another computer, or the same one paired again: a new API object.
    expect(scrollPlace("agents", two)).toBeUndefined();
    const other = renderHook(() => useRememberedScroll<Row>("agents", () => data, idOf, two));
    const list = { scrollToIndex: jest.fn(), scrollToOffset: jest.fn() };
    other.result.current.ref.current = list as never;
    act(() => other.result.current.onContentSizeChange());
    expect(list.scrollToIndex).not.toHaveBeenCalled();
  });

  test("a place too near the end to reach stops being restored once the list stops there", () => {
    const data = rows("a", "b", "c");
    const first = mount("list", data);
    const cells = data.map((row, index) => render(createElement(first.api().CellRendererComponent, { item: row, cellKey: row.id, index, children: null, style: undefined })));
    cells.forEach((cell, index) => fireEvent(cell.UNSAFE_getByType(View), "layout", { nativeEvent: { layout: { y: 300 + index * 80, height: 80 } } }));
    act(() => first.api().onScrollBeginDrag());
    act(() => first.api().onScrollEndDrag({ nativeEvent: { contentOffset: { y: 470 } } } as never));
    expect(scrollPlace("list")).toBe("c");
    first.unmount();
    const again = mount("list", data);
    cells.forEach((cell) => cell.unmount());
    const more = data.map((row, index) => render(createElement(again.api().CellRendererComponent, { item: row, cellKey: row.id, index, children: null, style: undefined })));
    more.forEach((cell, index) => fireEvent(cell.UNSAFE_getByType(View), "layout", { nativeEvent: { layout: { y: 300 + index * 80, height: 80 } } }));
    act(() => again.api().onContentSizeChange());
    // The screen is taller now: the list can only reach 400.
    act(() => again.api().onScroll({ nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 } } } as never));
    again.list.scrollToIndex.mockClear();
    act(() => again.api().onContentSizeChange());
    expect(again.list.scrollToIndex).not.toHaveBeenCalled();
    more.forEach((cell) => cell.unmount());
  });
});
