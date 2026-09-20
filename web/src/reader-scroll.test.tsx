import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useRef } from "react";
import { forgetReaderPlace, readerWasAway, useReaderScroll } from "./reader-scroll";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
let resized: () => void;
const originalObserver = globalThis.ResizeObserver;
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; forgetReaderPlace(); globalThis.ResizeObserver = originalObserver; });
function setup() {
  globalThis.ResizeObserver = class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} } as any;
  let top = 0;
  const rows = [{ id: "one", y: 0, height: 400 }, { id: "two", y: 400, height: 800 }, { id: "three", y: 1200, height: 800 }];
  const node: any = { scrollHeight: 2100, clientHeight: 500, get scrollTop() { return top; }, set scrollTop(y: number) { top = Math.max(0, Math.min(y, this.scrollHeight - this.clientHeight)); }, getBoundingClientRect: () => ({ top: 100 }), children: [] };
  const elements = rows.map(row => ({ dataset: { messageId: row.id }, getBoundingClientRect: () => ({ top: 100 + row.y - top, bottom: 100 + row.y + row.height - top }) }));
  node.children = elements;
  node.querySelectorAll = () => elements;
  node.querySelector = () => elements[0];
  let controls!: ReturnType<typeof useReaderScroll>;
  const positions: boolean[] = [];
  function Harness({ revision = 0 }: { revision?: number }) {
    const scroller = useRef(node), following = useRef(!readerWasAway("pane"));
    controls = useReaderScroll({ paneId: "pane", scroller, ready: true, revision, following, onPosition: bottom => positions.push(bottom) });
    return null;
  }
  return { node, rows, positions, Harness, get controls() { return controls; } };
}

test("reopening restores the same paragraph and corrects later content-height changes", async () => {
  const s = setup();
  await act(async () => { view = create(<s.Harness />); });
  expect(s.node.scrollTop).toBe(1600);
  await act(async () => { s.controls.stopFollowing(); s.node.scrollTop = 600; s.controls.onScroll(); });
  await act(async () => view!.unmount());
  s.node.scrollTop = 0;
  await act(async () => { view = create(<s.Harness />); });
  expect(s.node.scrollTop).toBe(600);
  expect(s.positions.at(-1)).toBe(false);
  s.rows[1]!.y += 150; s.node.scrollHeight += 150;
  await act(async () => resized());
  expect(s.node.scrollTop).toBe(750);
  // A restoration scroll event must not replace the intended paragraph.
  await act(async () => s.controls.onScroll());
  expect(s.node.scrollTop).toBe(750);
});

test("Latest reaches the real bottom including padding and follows late growth", async () => {
  const s = setup();
  await act(async () => { view = create(<s.Harness />); });
  await act(async () => { s.controls.stopFollowing(); s.node.scrollTop = 300; s.controls.onScroll(); s.controls.goLatest(); });
  expect(s.node.scrollTop).toBe(s.node.scrollHeight - s.node.clientHeight);
  s.node.scrollHeight += 900;
  await act(async () => resized());
  expect(s.node.scrollTop).toBe(2500);
  expect(s.positions.at(-1)).toBe(true);
});

test("prepending history preserves the current paragraph instead of jumping", async () => {
  const s = setup();
  await act(async () => { view = create(<s.Harness />); });
  await act(async () => { s.controls.stopFollowing(); s.node.scrollTop = 600; s.controls.onScroll(); s.controls.captureBeforePrepend(); });
  s.rows.forEach(row => { row.y += 1000; }); s.node.scrollHeight += 1000;
  await act(async () => view!.update(<s.Harness revision={1} />));
  expect(s.node.scrollTop).toBe(1600);
});

test("clearing or evicting conversation memory discards its reading position", async () => {
  const s = setup();
  await act(async () => { view = create(<s.Harness />); });
  await act(async () => { s.controls.stopFollowing(); s.node.scrollTop = 600; s.controls.onScroll(); });
  expect(readerWasAway("pane")).toBe(true);
  forgetReaderPlace("pane");
  await act(async () => view!.unmount());
  expect(readerWasAway("pane")).toBe(false);
  await act(async () => { view = create(<s.Harness />); });
  expect(s.node.scrollTop).toBe(1600);
});

test("scrollIntoView and accessibility scrolling can move away without a pointer gesture", async () => {
  const s = setup();
  await act(async () => { view = create(<s.Harness />); });
  await act(async () => { s.node.scrollTop = 450; s.controls.onScroll(); });
  expect(s.node.scrollTop).toBe(450);
  expect(s.positions.at(-1)).toBe(false);
  await act(async () => resized());
  expect(s.node.scrollTop).toBe(450);
});
